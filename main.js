/* 天气卡片（独立版）—— Electron 主进程
   从合体版「WeatherWidget 1.9.1」拆出：本应用只带天气一张卡。
   透明无边框窗口 + 可拖动 + 记忆位置 + 右键菜单 + IP 定位 */

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

/* 卡片尺寸 + 四周留给投影的透明边距 */
const CARD_W = 320;
const CARD_H = 392;

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
/* 磨砂模式窗口就是卡片大小（页面全透明，投影也画不出来）；
   透明窗口那边由页面自绘投影，四周留 22px 透明边距。 */
const PAD = USE_ACRYLIC ? 0 : 22;

let weatherWin = null;

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
  writeState(s);
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    /* 原子写：先写临时文件，再用 rename 一瞬间替换正主。
       直接改写原文件时，写一半断电/崩溃会留下半截 JSON，下次启动
       readState 解析失败，位置和置顶就全丢了。rename 在同一块盘上是
       原子操作——任何时刻文件要么是旧的、要么是完整的新的，没有中间态。 */
    const tmp = stateFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, stateFile());
  } catch (e) { /* 写不进去也不影响使用，只是记不住位置 */ }
}

/* ---------- 首次启动迁移 ----------
   独立版存档在 %APPDATA%\WeatherCard，合体版在 %APPDATA%\weather-widget。
   第一次启动把合体版的窗口位置/置顶搬过来；Local Storage（搜索城市等页面数据）
   也整个目录复制过去。已有自己的存档就不动。 */
function maybeMigrateLegacy() {
  try {
    if (fs.existsSync(stateFile())) return;
    const legacyDir = path.join(app.getPath("appData"), "weather-widget");
    const legacyState = path.join(legacyDir, "widget-state.json");
    if (!fs.existsSync(legacyState)) return;
    const ls = path.join(legacyDir, "Local Storage");
    if (fs.existsSync(ls)) {
      fs.cpSync(ls, path.join(app.getPath("userData"), "Local Storage"), {
        recursive: true, force: false,
      });
    }
    const legacy = JSON.parse(fs.readFileSync(legacyState, "utf8")) || {};
    const seed = { openCards: ["weather"] };
    if (Number.isFinite(legacy.x)) { seed.x = legacy.x; seed.y = legacy.y; }
    if (legacy.top === true) seed.top = true;
    writeState(seed);
  } catch (e) { /* 搬不动就全新开始，不影响启动 */ }
}

function createWindow() {
  if (weatherWin && !weatherWin.isDestroyed()) {   /* 已经在跑就只唤到前面，不开第二个 */
    if (weatherWin.isMinimized()) weatherWin.restore();
    weatherWin.show();
    weatherWin.focus();
    return weatherWin;
  }

  const WIN_W = CARD_W + PAD * 2;
  const WIN_H = CARD_H + PAD * 2;

  const st = readState();
  const wa = screen.getPrimaryDisplay().workArea;
  const top = st.top === true;   /* 默认不置顶：卡片安静待在桌面上，不压在其他窗口前面 */

  /* 默认贴右上角 */
  const defX = wa.x + wa.width - WIN_W - 24;
  const defY = wa.y + 54;

  let x = Number.isFinite(st.x) ? st.x : defX;
  let y = Number.isFinite(st.y) ? st.y : defY;

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

  const w = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: x,
    y: y,
    frame: false,
    /* 磨砂与"透明窗口"在 Windows 上二选一：
       acrylic 走系统绘制，需要非透明窗口 + 全透明背景色。
       透明窗口那边连 backgroundMaterial 字段都不能带 —— 带着（哪怕是 "none"）
       窗口仍会走材质合成路径，页面内容会被压成几乎看不见的一层。 */
    transparent: !USE_ACRYLIC,
    backgroundColor: "#00000000",
    ...(USE_ACRYLIC ? { backgroundMaterial: "acrylic" } : {}),
    hasShadow: false,          // 无边框窗口自带阴影会把直角露出来
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: top,
    show: false,
    title: "天气卡片",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      /* 把"是否启用系统磨砂"透给页面：磨砂模式下卡片必须全透明，否则会把它盖住 */
      additionalArguments: [
        "--wgt-acrylic=" + (USE_ACRYLIC ? "1" : "0"),
        "--wgt-card=weather",
      ],
      backgroundThrottling: false, // 后台不降频，否则切走再回来数字是旧的
    },
  });

  if (top) w.setAlwaysOnTop(true, "floating");

  /* Win+D（显示桌面）会最小化卡片，但透明无边框的置顶窗过一会儿会被 Chromium
     自己弹回来 —— 最小化状态和 alwaysOnTop 互相打架，看起来就是"按了显示桌面
     它又自己冒出来"。干脆最小化时直接隐藏，桌面就真正干净了；
     想唤回：双击桌面快捷方式（second-instance 会还原+显示）。 */
  w.on("minimize", () => { if (!w.isDestroyed()) w.hide(); });

  /* 窗口事件留痕（%APPDATA%\WeatherCard\win-events.log）：窗口生命周期事件很罕见，
     一旦用户再报"卡片自己消失/弹出"，这就是精确现场。 */
  const evlog = (ev) => {
    try {
      fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
        new Date().toISOString() + " " + ev + "\n");
    } catch (e) { /* 日志失败不影响功能 */ }
  };
  ["minimize", "restore", "show", "hide"].forEach((ev) => w.on(ev, () => evlog(ev)));

  /* 定位权限放行，拿不到会自动降级到网络定位 */
  try {
    w.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === "geolocation");
    });
  } catch (e) { /* 某些版本没有该方法 */ }

  w.loadFile(path.join(__dirname, "widget.html"));

  w.once("ready-to-show", () => { w.show(); });

  /* 位置记忆（拖动会高频触发，做节流） */
  let moveTimer = null;
  w.on("moved", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (w.isDestroyed()) return;
      const b = w.getBounds();
      patchState({ x: b.x, y: b.y });
    }, 400);
  });

  w.on("closed", () => { weatherWin = null; });

  return w;
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
    { label: "刷新天气", accelerator: "F5", click: () => weatherWin && weatherWin.webContents.send("wgt:refresh") },
    { label: "搜索城市…", click: () => weatherWin && weatherWin.webContents.send("wgt:search-open") },
    { label: "回到自动定位", click: () => weatherWin && weatherWin.webContents.send("wgt:relocate") },
    { type: "separator" },
    {
      label: "桌面右键菜单显示",
      type: "checkbox",
      checked: desktopMenu,
      click: async (item) => {
        /* 写失败（权限/组策略）就如实回弹，别让勾选状态骗人 */
        item.checked = await setDesktopMenu(item.checked);
      },
    },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: getAutoStart(),
      click: (item) => setAutoStart(item.checked),
    },
    { type: "separator" },
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: onTop,
      click: (item) => {
        patchState({ top: item.checked });
        if (weatherWin && !weatherWin.isDestroyed()) {
          weatherWin.setAlwaysOnTop(item.checked, "floating");
        }
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
    createWindow();
  });
}

app.whenReady().then(() => {
  maybeMigrateLegacy();
  createWindow();

  const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.on("wgt:close", (e) => {
    const w = senderWin(e);
    if (w) w.close();
  });

  ipcMain.on("wgt:menu", async (e) => {
    const w = senderWin(e);
    if (!w) return;
    const m = await buildMenu();
    /* 菜单弹出时卡片会失焦、鼠标也离开页面。标记一下，免得这时候被"还原到后面"，
       结果菜单还开着、卡片已经被别的窗口盖住。 */
    w.__menuOpen = true;
    w.__restPending = false;
    m.popup({
      window: w,
      callback: () => {
        if (w.isDestroyed()) return;
        w.__menuOpen = false;
        if (!w.__restPending) return;
        w.__restPending = false;
        w.setAlwaysOnTop(readState().top === true, "floating");
      },
    });
  });

  /* ---------- 鼠标指上来就临时浮到最前 ----------
     按"点一下"才浮上来太迟钝；hover 即抬升、移开即还原 —— 都是临时的，
     不写进存档，用户自己在菜单里设的"窗口置顶"不能被它改掉。 */
  ipcMain.on("wgt:raise", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__hoverTop = true;
    if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, "floating");
    /* ★ 只打上"置顶"这个样式并不会改变它在置顶层里的前后位置：
       其他窗口本来就是置顶的时候，光 setAlwaysOnTop 翻不上去 —— 实测 z 序一点没变。
       必须再主动提一次。 */
    w.moveTop();
  });

  ipcMain.on("wgt:rest", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__hoverTop = false;
    if (w.__menuOpen) { w.__restPending = true; return; }   /* 菜单还开着，等它关了再沉 */
    w.setAlwaysOnTop(readState().top === true, "floating");
  });

  ipcMain.handle("wgt:geo-ip", async () => {
    try {
      return await lookupGeoIP();
    } catch (e) {
      return [];
    }
  });
});

app.on("window-all-closed", () => { app.quit(); });
