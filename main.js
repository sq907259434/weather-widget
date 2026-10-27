/* 天气桌面卡片 —— Electron 主进程
   透明无边框窗口 + 置顶 + 可拖动 + 记忆位置 + 右键菜单 */

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

/* 卡片尺寸 + 四周留给投影的透明边距 */
const CARD_W = 320;
const CARD_H = 356;

/* Windows 11 22H2+ 才有原生 acrylic。有就用系统磨砂（实时、真实模糊窗口背后的桌面）；
   没有就退回半透明渐变。 */
function acrylicSupported() {
  try {
    const parts = String(require("os").release()).split(".");
    const build = parseInt(parts[2], 10);
    return Number.isFinite(build) && build >= 22621;
  } catch (e) {
    return false;
  }
}
const USE_ACRYLIC = acrylicSupported();
const PAD = USE_ACRYLIC ? 0 : 22;
const WIN_W = CARD_W + PAD * 2;
const WIN_H = CARD_H + PAD * 2;

let win = null;

const stateFile = () => path.join(app.getPath("userData"), "widget-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function patchState(patch) {
  const s = readState();
  Object.assign(s, patch);
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
  } catch (e) { /* 写不进去也不影响使用，只是记不住位置 */ }
}

function createWindow() {
  const st = readState();
  const wa = screen.getPrimaryDisplay().workArea;
  const top = st.top === true;   /* 默认不置顶：卡片安静待在桌面上，不压在其他窗口前面 */

  /* 默认贴右上角，之后用记住的位置 */
  let x = Number.isFinite(st.x) ? st.x : wa.x + wa.width - WIN_W - 24;
  let y = Number.isFinite(st.y) ? st.y : wa.y + 54;

  /* 位置兜底：换显示器、拔掉副屏、或系统把窗口挪到边缘时，
     旧坐标可能让卡片贴边甚至跑到屏幕外。这里强制夹回可视区内并留出边距。 */
  const MARGIN = 14;
  const target = screen.getAllDisplays().find((d) => {
    const a = d.workArea;
    return x + WIN_W / 2 >= a.x && x + WIN_W / 2 <= a.x + a.width &&
           y + WIN_H / 2 >= a.y && y + WIN_H / 2 <= a.y + a.height;
  }) || screen.getPrimaryDisplay();

  const ta = target.workArea;
  x = Math.min(Math.max(x, ta.x + MARGIN), ta.x + ta.width - WIN_W - MARGIN);
  y = Math.min(Math.max(y, ta.y + MARGIN), ta.y + ta.height - WIN_H - MARGIN);

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: x,
    y: y,
    frame: false,
    /* 磨砂与"透明窗口"在 Windows 上二选一：
       acrylic 走系统绘制，需要非透明窗口 + 全透明背景色 */
    transparent: !USE_ACRYLIC,
    backgroundColor: "#00000000",
    backgroundMaterial: USE_ACRYLIC ? "acrylic" : "none",
    hasShadow: false,          // 无边框窗口自带阴影会把直角露出来
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: top,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      /* 把"是否启用系统磨砂"透给页面：磨砂模式下卡片必须全透明，否则会把它盖住 */
      additionalArguments: ["--wgt-acrylic=" + (USE_ACRYLIC ? "1" : "0")],
      backgroundThrottling: false, // 后台不降频，否则切走再回来数字是旧的
    },
  });

  if (top) win.setAlwaysOnTop(true, "floating");

  /* 定位权限放行，拿不到会自动降级到网络定位 */
  try {
    win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === "geolocation");
    });
  } catch (e) { /* 某些版本没有该方法 */ }

  win.loadFile(path.join(__dirname, "widget.html"));

  win.once("ready-to-show", () => {
    win.show();
  });

  /* 位置记忆（拖动会高频触发，做节流） */
  let moveTimer = null;
  win.on("moved", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      patchState({ x: b.x, y: b.y });
    }, 400);
  });

  win.on("closed", () => { win = null; });
}

/* ---------- IP 归属查询（主进程） ----------
   Node 的 fetch 走直连，不读系统代理；渲染进程的 fetch 会跟随 Windows 系统代理，
   一旦机器上挂着代理/VPN，出口 IP 就在境外，定位会错到别的国家。 */
const GEO_SOURCES = [
  {
    id: "ip.sb",
    url: "https://api.ip.sb/geoip",
    pick: (d) => (d && d.latitude != null) ? {
      lat: d.latitude, lon: d.longitude,
      city: d.city, tz: d.timezone || "", cc: d.country_code || "",
    } : null,
  },
  {
    id: "ipwho",
    url: "https://ipwho.is/?lang=zh-CN",
    pick: (d) => (d && d.success !== false && d.latitude != null) ? {
      lat: d.latitude, lon: d.longitude,
      city: d.city || d.region,
      tz: (d.timezone && d.timezone.id) || "", cc: d.country_code || "",
    } : null,
  },
];

async function lookupGeoIP() {
  const tasks = GEO_SOURCES.map(async (src) => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 3000);
    try {
      const r = await fetch(src.url, {
        signal: ac.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (!r.ok) return null;
      const v = src.pick(await r.json());
      return v ? Object.assign({ src: src.id }, v) : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(to);
    }
  });

  const list = (await Promise.all(tasks)).filter(Boolean);
  return list;
}

/* 开机自启：绿色版会把 exe 解到临时目录再运行，直接用 process.execPath 会指向临时文件，
   electron-builder 的 portable 运行器给了 PORTABLE_EXECUTABLE_FILE，优先用它。 */
function launchExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getAutoStart() {
  try {
    return app.getLoginItemSettings({ path: launchExePath() }).openAtLogin === true;
  } catch (e) {
    return false;
  }
}

function setAutoStart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: launchExePath(), args: [] });
    return getAutoStart();
  } catch (e) {
    return false;
  }
}

/* ---------- 桌面空白处右键菜单 ----------
   往 HKCU\Software\Classes\DesktopBackground\Shell 下写一项，不碰 HKLM、不需要管理员。
   Explorer 会实时读这个位置，写完立刻生效；关掉就删掉整项。 */
const DESKTOP_MENU_KEY = "HKCU\\Software\\Classes\\DesktopBackground\\Shell\\WeatherWidget";

function reg(args) {
  return new Promise((resolve) => {
    try {
      execFile("reg", args, { windowsHide: true }, (err) => resolve(!err));
    } catch (e) {
      resolve(false);
    }
  });
}

function getDesktopMenu() {
  return reg(["query", DESKTOP_MENU_KEY]);
}

async function setDesktopMenu(on) {
  if (!on) {
    await reg(["delete", DESKTOP_MENU_KEY, "/f"]);
    return getDesktopMenu();
  }
  const exe = launchExePath();
  await reg(["add", DESKTOP_MENU_KEY, "/ve", "/d", "显示天气卡片", "/f"]);
  await reg(["add", DESKTOP_MENU_KEY, "/v", "Icon", "/d", exe, "/f"]);
  /* 命令里带空格必须自己加引号，reg 不会替你转义 */
  await reg(["add", DESKTOP_MENU_KEY + "\\command", "/ve", "/d", '"' + exe + '"', "/f"]);
  return getDesktopMenu();
}

async function buildMenu() {
  const st = readState();
  const onTop = st.top === true;
  const desktopMenu = await getDesktopMenu();

  return Menu.buildFromTemplate([
    {
      label: "刷新天气",
      accelerator: "F5",
      click: () => win && win.webContents.send("wgt:refresh"),
    },
    {
      label: "搜索城市…",
      click: () => win && win.webContents.send("wgt:search-open"),
    },
    {
      label: "回到自动定位",
      click: () => win && win.webContents.send("wgt:relocate"),
    },
    { type: "separator" },
    {
      label: "桌面右键菜单显示",
      type: "checkbox",
      checked: desktopMenu,
      click: async (item) => {
        const now = await setDesktopMenu(item.checked);
        /* 写失败（权限/组策略）就如实回弹，别让勾选状态骗人 */
        item.checked = now;
      },
    },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: getAutoStart(),
      click: (item) => setAutoStart(item.checked),
    },
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: onTop,
      click: (item) => {
        patchState({ top: item.checked });
        if (win) win.setAlwaysOnTop(item.checked, "floating");
      },
    },
    { type: "separator" },
    { label: "退出", role: "quit" },
  ]);
}

/* 只允许一个实例，重复双击只把已开的窗口提到前面 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.on("wgt:close", () => { if (win) win.close(); });
  ipcMain.on("wgt:menu", async () => {
    if (!win) return;
    const m = await buildMenu();
    m.popup({ window: win });
  });
  ipcMain.handle("wgt:get-top", () => readState().top === true);
  ipcMain.handle("wgt:set-top", (e, v) => {
    patchState({ top: !!v });
    if (win) win.setAlwaysOnTop(!!v, "floating");
    return !!v;
  });
  ipcMain.handle("wgt:geo-ip", async () => {
    try {
      return await lookupGeoIP();
    } catch (e) {
      return [];
    }
  });
  ipcMain.handle("wgt:card-size", () => ({ w: CARD_W, h: CARD_H }));
});

app.on("window-all-closed", () => app.quit());
