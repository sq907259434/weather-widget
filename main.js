/* 天气桌面卡片 —— Electron 主进程
   透明无边框窗口 + 置顶 + 可拖动 + 记忆位置 + 右键菜单 */

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

/* 卡片尺寸 + 四周留给投影的透明边距 */
const CARD_W = 320;
const CARD_H = 392;
const TODO_W = 320;
const TODO_H = 302;

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

/* 每张卡各自决定要不要系统磨砂。
   天气卡照旧（磨砂好看）；待办卡不行 —— 它平时要"只剩任务框"，
   卡片背景必须真的透出桌面，而 acrylic 材质会铺满整个窗口矩形，
   页面再透明也会被系统那层糊住。所以待办走透明窗口 + 页面自绘。 */
const CARD_ACRYLIC = { weather: USE_ACRYLIC, todo: false };
const cardAcrylic = (kind) => CARD_ACRYLIC[kind] !== false && USE_ACRYLIC;
/* 待办窗口必须正好等于卡片：它靠"鼠标碰到"来决定展开，
   四周要是留了透明边距，鼠标还在卡片外面卡片就弹开了。 */
const padOf = (kind) => (kind === "todo" ? 0 : (USE_ACRYLIC ? 0 : 22));

/* 两张卡片的共同配置。stateKey 为 null 的用顶层 x/y/top（天气卡片沿用旧存档，
   不破坏用户已经拖好的位置）；待办用 state.todo 子对象，各记各的。 */
const CARDS = {
  weather: {
    key: "weather",
    w: CARD_W, h: CARD_H,
    html: "widget.html",
    stateKey: null,
    title: "天气卡片",
  },
  todo: {
    key: "todo",
    w: TODO_W, h: TODO_H,
    html: "todo.html",
    stateKey: "todo",
    title: "待办卡片",
    /* 高度由页面自己报：几条就多高，1 条最矮，每多一条 +33。
       v1.5.0 起收起状态只有条目，1 条时卡片约 58px，所以 minH 降到 50。
       maxH 在运行时按屏幕工作区再算。 */
    autoHeight: true,
    minH: 50,
  },
};

let weatherWin = null;
let todoWin = null;

const winOf = (kind) => (kind === "todo" ? todoWin : weatherWin);
function setWin(kind, w) {
  if (kind === "todo") todoWin = w; else weatherWin = w;
}

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
    fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
  } catch (e) { /* 写不进去也不影响使用，只是记不住位置 */ }
}

/* 按卡片读取自己的位置/置顶 */
function readCardState(kind) {
  const cfg = CARDS[kind];
  const st = readState();
  return cfg.stateKey ? (st[cfg.stateKey] || {}) : st;
}

function patchCardState(kind, patch) {
  const cfg = CARDS[kind];
  if (!cfg.stateKey) { patchState(patch); return; }
  const st = readState();
  st[cfg.stateKey] = Object.assign({}, st[cfg.stateKey] || {}, patch);
  writeState(st);
}

function createWindow(kind) {
  const cfg = CARDS[kind] || CARDS.weather;
  const alive = winOf(kind);
  if (alive && !alive.isDestroyed()) {   /* 已经在跑就只唤到前面，不开第二个 */
    if (alive.isMinimized()) alive.restore();
    alive.show();
    alive.focus();
    return alive;
  }

  const acrylic = cardAcrylic(kind);
  const PAD = padOf(kind);              /* 四周留给投影的透明边距；透明窗口不需要 */
  const WIN_W = cfg.w + PAD * 2;
  const WIN_H = cfg.h + PAD * 2;

  const st = readCardState(kind);
  const wa = screen.getPrimaryDisplay().workArea;
  const top = st.top === true;   /* 默认不置顶：卡片安静待在桌面上，不压在其他窗口前面 */

  /* 默认贴右上角；待办叠在天气卡片正下方，免得两张卡压在一起 */
  const defX = wa.x + wa.width - WIN_W - 24;
  const defY = kind === "todo"
    ? wa.y + 54 + (CARD_H + padOf("weather") * 2) + 14
    : wa.y + 54;

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
    transparent: !acrylic,
    backgroundColor: "#00000000",
    ...(acrylic ? { backgroundMaterial: "acrylic" } : {}),
    hasShadow: false,          // 无边框窗口自带阴影会把直角露出来
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: top,
    show: false,
    title: cfg.title,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      /* 把"是否启用系统磨砂"透给页面：磨砂模式下卡片必须全透明，否则会把它盖住 */
      additionalArguments: [
        "--wgt-acrylic=" + (acrylic ? "1" : "0"),
        "--wgt-card=" + cfg.key,
      ],
      backgroundThrottling: false, // 后台不降频，否则切走再回来数字是旧的
    },
  });

  if (top) w.setAlwaysOnTop(true, "floating");

  /* 锚点不用顶边，用"待办条目在屏幕上的 y"（__rowsY）。
     卡片悬停展开时顶栏+输入条会把条目往下推 65px，只有咬住条目本身，
     鼠标底下的行才不会动。第一次由页面报高度时按当时的窗口位置推出来。 */
  w.__rowsY = null;
  w.__pad = PAD;     /* 这张卡的透明边距，后面所有 y 换算都按它来 */

  /* 定位权限放行，拿不到会自动降级到网络定位（只有天气卡片用得到） */
  if (kind === "weather") {
    try {
      w.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
        cb(permission === "geolocation");
      });
    } catch (e) { /* 某些版本没有该方法 */ }
  }

  w.loadFile(path.join(__dirname, cfg.html));

  w.once("ready-to-show", () => { w.show(); });

  /* 位置记忆（拖动会高频触发，做节流） */
  let moveTimer = null;
  w.on("moved", () => {
    /* 自动伸缩时我们会自己改 y（展开时向上长、长高了贴底时往上顶），
       那不是用户拖的，别覆盖存档。用"目标 y 精确比对"而不是时间窗：
       setBounds 触发的 moved 在 Windows 上可能晚到，靠计时器复位容易漏判。 */
    const b = w.getBounds();
    if (w.__autoY != null && b.y === w.__autoY) return;
    w.__autoY = null;
    w.__rowsY = b.y + w.__pad + (w.__top || 0);   /* 锚点跟着用户整体平移 */
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (w.isDestroyed()) return;
      const bb = w.getBounds();
      /* 存“收起状态”的顶边：拖动只可能在展开时发生（顶栏才看得见），
         直接存当前 y 的话，下次启动卡片会比用户摆的高 65px。 */
      const idleY = Math.round(bb.y + (w.__top || 0) - (w.__topMin || 0));
      patchCardState(kind, { x: bb.x, y: idleY });
    }, 400);
  });

  w.on("closed", () => {
    setWin(kind, null);
    if (app.__quitting) return;
    /* 只有在"还有别的卡开着"时才算用户单独关掉这张。
       关掉最后一张 = 整个应用要退出了（window-all-closed → quit），
       这时如果也记成"关掉"，openCards 会丢掉卡片，下次启动就只剩天气卡。
       不能立刻判断：两张卡一起关时，先关那张看到另一张还活着，就会误记。
       所以等一拍 —— 应用真退出了这个定时器根本来不及跑，也就不会误记。 */
    setTimeout(() => {
      if (app.__quitting || w.isDestroyed()) return;
      const alive = [weatherWin, todoWin].filter((x) => x && !x.isDestroyed()).length;
      if (alive > 0) markOpen(kind, false);
    }, 400);
  });

  markOpen(kind, true);
  setWin(kind, w);
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

async function buildMenu(kind) {
  const cfg = CARDS[kind] || CARDS.weather;
  const st = readCardState(cfg.key);
  const onTop = st.top === true;
  const desktopMenu = await getDesktopMenu();
  const w = winOf(cfg.key);

  const items = [];

  if (cfg.key === "weather") {
    items.push(
      { label: "刷新天气", accelerator: "F5", click: () => weatherWin && weatherWin.webContents.send("wgt:refresh") },
      { label: "搜索城市…", click: () => weatherWin && weatherWin.webContents.send("wgt:search-open") },
      { label: "回到自动定位", click: () => weatherWin && weatherWin.webContents.send("wgt:relocate") },
    );
  } else {
    items.push(
      { label: "添加待办", accelerator: "CmdOrCtrl+N", click: () => todoWin && todoWin.webContents.send("todo:focus-input") },
      { label: "历史记录", click: () => todoWin && todoWin.webContents.send("todo:show-history") },
      { label: "清除已完成", click: () => todoWin && todoWin.webContents.send("todo:clear-done") },
    );
  }

  items.push({ type: "separator" });

  /* 两张卡片互相唤出 */
  if (cfg.key === "weather") {
    items.push({
      label: "显示待办卡片",
      type: "checkbox",
      checked: !!(todoWin && !todoWin.isDestroyed()),
      click: (item) => {
        if (item.checked) createWindow("todo");
        else if (todoWin) todoWin.close();
      },
    });
  } else {
    items.push({
      label: "显示天气卡片",
      type: "checkbox",
      checked: !!(weatherWin && !weatherWin.isDestroyed()),
      click: (item) => {
        if (item.checked) createWindow("weather");
        else if (weatherWin) weatherWin.close();
      },
    });
  }

  /* 桌面右键菜单 / 开机自启属于「全局设置」，放在天气卡片的菜单里，不重复出现 */
  if (cfg.key === "weather") {
    items.push(
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
    );
  }

  items.push(
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: onTop,
      click: (item) => {
        patchCardState(cfg.key, { top: item.checked });
        if (w && !w.isDestroyed()) w.setAlwaysOnTop(item.checked, "floating");
      },
    },
    { type: "separator" },
    { label: "退出", role: "quit" },
  );

  return Menu.buildFromTemplate(items);
}

/* 只允许一个实例，重复双击只把已开的窗口提到前面 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    /* 重复双击：把已经开着的卡片都唤到前面；一张都没开就重新建天气卡片 */
    const alive = [weatherWin, todoWin].filter((w) => w && !w.isDestroyed());
    if (!alive.length) { createWindow("weather"); return; }
    alive.forEach((w) => {
      if (w.isMinimized()) w.restore();
      w.show();
    });
    alive[0].focus();
  });
}

/* 记住哪些卡片是开着的：下次启动照旧。用户点 × 关掉待办，就不再自动弹出来。 */
function openedCards() {
  const st = readState();
  if (Array.isArray(st.openCards) && st.openCards.length) {
    return st.openCards.filter((k) => CARDS[k]);
  }
  return ["weather"];
}

function markOpen(kind, open) {
  const st = readState();
  const set = new Set(openedCards());
  if (open) set.add(kind); else set.delete(kind);
  st.openCards = [...set];
  writeState(st);
}

app.whenReady().then(() => {
  /* 默认只开天气；如果上次关程序时待办是开着的，一并恢复 */
  openedCards().forEach((kind) => createWindow(kind));

  const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);
  const kindOf = (e) => {
    const w = senderWin(e);
    if (!w) return "weather";
    if (todoWin && w.id === todoWin.id) return "todo";
    return "weather";
  };

  ipcMain.on("wgt:close", (e) => {
    const w = senderWin(e);
    if (w) w.close();
  });

  ipcMain.on("wgt:menu", async (e) => {
    const w = senderWin(e);
    if (!w) return;
    const kind = kindOf(e);
    const m = await buildMenu(kind);
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
        w.setAlwaysOnTop(readCardState(kind).top === true, "floating");
      },
    });
  });

  ipcMain.handle("wgt:get-top", (e) => readCardState(kindOf(e)).top === true);

  ipcMain.handle("wgt:set-top", (e, v) => {
    patchCardState(kindOf(e), { top: !!v });
    const w = senderWin(e);
    if (w) w.setAlwaysOnTop(!!v, "floating");
    return !!v;
  });

  /* ---------- 鼠标指上来就临时浮到最前 ----------
     两张卡是两个独立窗口，谁在上由系统 z 序决定。用户把天气卡拖到待办卡上，
     待办卡就被压住了；按以前的逻辑只有"点一下"（窗口被激活）才会浮上来。
     这里改成 hover 即抬升、移开即还原 —— 都是临时的，不写进存档，
     用户自己在菜单里设的"窗口置顶"不能被它改掉。 */
  ipcMain.on("wgt:raise", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__hoverTop = true;
    if (!w.isAlwaysOnTop()) w.setAlwaysOnTop(true, "floating");
    /* ★ 只打上"置顶"这个样式并不会改变它在置顶层里的前后位置：
       另一张卡本来就是置顶的（或者刚被系统排到前面）时，光 setAlwaysOnTop
       翻不上去 —— 实测 z 序一点没变。必须再主动提一次。 */
    w.moveTop();
  });

  ipcMain.on("wgt:rest", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__hoverTop = false;
    if (w.__menuOpen) { w.__restPending = true; return; }   /* 菜单还开着，等它关了再沉 */
    w.setAlwaysOnTop(readCardState(kindOf(e)).top === true, "floating");
  });

  /* ---------- 由页面发起的拖窗 ----------
     条目本身必须吃掉 mousedown（要判双击、要支持右滑删除），所以它不能直接做
     -webkit-app-region: drag。这里退一步：页面按屏幕坐标算位移，主进程照着挪窗口。
     用屏幕坐标而不是 client 坐标 —— 窗口一动，client 坐标就失真，屏幕坐标不会。 */
  ipcMain.on("wgt:drag-begin", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    w.__dragFrom = w.getBounds();
  });

  ipcMain.on("wgt:drag-move", (e, dx, dy) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed() || !w.__dragFrom) return;
    const f = w.__dragFrom;
    w.setPosition(Math.round(f.x + (Number(dx) || 0)), Math.round(f.y + (Number(dy) || 0)));
    /* 兜底：鼠标冲出窗口后页面可能再也收不到事件，别让窗口一直黏着鼠标 */
    clearTimeout(w.__dragTimer);
    w.__dragTimer = setTimeout(() => { if (!w.isDestroyed()) w.__dragFrom = null; }, 1200);
  });

  ipcMain.on("wgt:drag-end", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    clearTimeout(w.__dragTimer);
    w.__dragFrom = null;
  });

  ipcMain.handle("wgt:geo-ip", async () => {
    try {
      return await lookupGeoIP();
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle("wgt:card-size", (e) => {
    const c = CARDS[kindOf(e)];
    return { w: c.w, h: c.h };
  });

  /* 页面按内容报高度，主进程改窗口尺寸。
     页面报 { h, top, topMin }：h=卡片高度，top=待办区上沿距卡片顶的距离，
     topMin=收起状态下的 top。y 用"条目在屏幕上不动"反推，所以悬停展开时
     顶栏和输入条是从上面长出来的，鼠标底下的条目纹丝不动。 */
  ipcMain.handle("wgt:set-card-height", (e, want) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return false;
    const cfg = CARDS[kindOf(e)];
    if (!cfg.autoHeight) return false;

    const msg = (want && typeof want === "object") ? want : { h: want, top: 0, topMin: 0 };
    const top = Math.max(0, Math.round(Number(msg.top) || 0));
    const topMin = Math.max(0, Math.round(Number(msg.topMin) || 0));

    const b = w.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const maxCard = Math.min(640, Math.round(wa.height * 0.72));
    const cardH = Math.round(
      Math.min(Math.max(Number(msg.h) || cfg.h, cfg.minH || cfg.h), maxCard)
    );
    const pad = w.__pad || 0;
    const H = cardH + pad * 2;

    if (w.__rowsY == null) w.__rowsY = b.y + pad + top;
    w.__top = top;
    w.__topMin = topMin;

    let y = Math.round(w.__rowsY - pad - top);
    y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - H - 8));

    if (H === b.height && y === b.y) return true;

    w.__autoY = y;      /* 记下这次是我们自己改的 y，moved 事件据此放行 */
    w.setBounds({ x: b.x, y: y, width: b.width, height: H }, false);
    setTimeout(() => { if (!w.isDestroyed()) w.__autoY = null; }, 1500);
    return true;
  });

  /* 页面里主动唤出另一张卡片（例如待办卡片上的按钮） */
  ipcMain.handle("wgt:open-card", (e, kind) => {
    if (!CARDS[kind]) return false;
    createWindow(kind);
    return true;
  });
});

app.on("before-quit", () => { app.__quitting = true; });
app.on("window-all-closed", () => { app.__quitting = true; app.quit(); });
