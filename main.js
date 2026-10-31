/* 天气卡片（独立版）—— Electron 主进程
   从合体版「WeatherWidget 1.9.1」拆出：本应用只带天气一张卡。
   透明无边框窗口 + 可拖动 + 记忆位置 + 右键菜单 + IP 定位 */

const { app, BrowserWindow, ipcMain, Menu, screen, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const createDesktopLayer = require("./desktop-layer");
const createBackdrop = require("./backdrop");

/* 卡片尺寸 + 四周留给投影的透明边距。
   CARD_H 从 392 收到 330（v1.0.13，用户挑的 C 档）：主区 .main 是 flex:1 + 内容垂直
   居中，卡片多高，顶部"昆明 → 22°"那段空白就一半归它 —— 只调内边距没用，内容会重新
   居中。矮 62 之后这段净间距从 57px 收到 26px，上下多余留白一起消掉。
   主区在 374 的窗口里仍有 117px，内容（大温度+描述+范围）约 101px，不挤。 */
const CARD_W = 320;
/* 330 装不下"5 小时条 + 空气/风/紫外线 + 三天预报 + 更新于"，
   底部会被 overflow:hidden 裁掉（用户报的"信息显示不全"）。
   放到 360 留出余量；卡片内部用的是 flex，多出来的空间由主区吸收。 */
const CARD_H = 360;

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
/* 磨砂材质是"系统给顶层窗口画的底"，贴进桌面层就没了 —— 所以两种模式互斥：
   开了「贴进桌面」就强制走透明自绘（多 22px 投影边距），否则会出现一块灰底。
   ⚠ 这两个值必须等 app ready 之后再定：模块加载时读 state 拿不到正确的 userData 路径
   （实测会读成空 → 磨砂照开 → 桌面层模式下变成一块灰底），所以在 whenReady 里赋值。 */
let USE_ACRYLIC = acrylicSupported();
let PAD = USE_ACRYLIC ? 0 : 22;
/* 磨砂模式窗口就是卡片大小（页面全透明，投影也画不出来）；
   透明窗口那边由页面自绘投影，四周留 22px 透明边距。 */

let weatherWin = null;

/* ---------- 把窗口沉到最底（HWND_BOTTOM） ----------
   用于所有"撤销置顶"的地方：Windows 把窗口从置顶组挪回普通组时，是插到普通组
   **最上面**，于是卡片会一直挡在别人前面，直到用户点一下那个窗口才被压回去
   （用户实测反馈：Win+D 退出「显示桌面」后卡片浮在刚恢复的窗口前面）。
   实测 Progman（桌面）永远被系统压在 Z 序最底，所以沉底后卡片依然可见：
   PowerShell 实测 卡片@41 / Progman@42 —— 桌面之上、其它应用之下，正是桌面卡片该待的位置。 */
const SWP_SINK = 0x0001 | 0x0002 | 0x0010 | 0x0200;   /* NOSIZE|NOMOVE|NOACTIVATE|NOOWNERZORDER */
let _SetWindowPos = null;
try {
  _SetWindowPos = require("koffi").load("user32.dll")
    .func("SetWindowPos", "bool", ["void *", "void *", "int", "int", "int", "int", "uint32"]);
} catch (e) { _SetWindowPos = null; }   /* 加载失败就只影响"沉底"，不影响其它功能 */

/* 桌面层句柄（createWindow 里赋值）。沉底这类"z 序操作"必须先问它一句：
   卡片一旦挂进 Progman，HWND_BOTTOM 会把它塞到 SHELLDLL_DefView（铺满全屏的图标层）
   下面 —— 表现就是「卡片自己消失了」，而 IsWindowVisible 还是 true、没有任何事件。
   实测证据见 desktop-layer.js 文件头坑 4。 */
let DL = null;

function sinkWin(win) {
  if (DL && DL.isOn()) return;     /* 桌面层模式下永远不沉底 */
  if (!_SetWindowPos || !win || win.isDestroyed()) return;
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    _SetWindowPos(hwnd, 1, 0, 0, 0, 0, SWP_SINK);   /* 1 = HWND_BOTTOM */
  } catch (e) { /* 失败就保持现状：卡片在最前，点一下别的窗口就退回去，不致命 */ }
}

/* 恢复"用户设置的置顶状态"，并保证非置顶时真正沉底（而不是卡在最前） */
function restoreTop(win) {
  if (!win || win.isDestroyed()) return;
  if (DL && DL.isOn()) return;   /* 桌面层里没有"置顶/沉底"这回事，一沉就掉进图标层后面 */
  let want = false;
  try { want = readState().top === true; } catch (e) { want = false; }
  win.setAlwaysOnTop(want, "floating");
  if (!want) setTimeout(() => sinkWin(win), 60);   /* 等 DWM 处理完"取消置顶"，再沉底 */
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

/* 贴进桌面层（state.desktopLayer）：窗口层级放在启动时做，切换就重启自己。
   万一贴进去看不见，按 Ctrl+Alt+2 = 把状态改回 false 再重启，窗口一定回来。 */
function desktopLayerOn() {
  try { return readState().desktopLayer === true; } catch (e) { return false; }
}

function toggleDesktopLayer(want) {
  const on = !!want;
  const cur = desktopLayerOn();
  patchState(on ? { desktopLayer: true, top: false } : { desktopLayer: false });
  if (cur === on) return on;
  app.relaunch();
  app.exit(0);
  return on;
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

/* ================= 拖动窗口：主进程直接跟着系统光标走 =================
   为什么把系统拖动（-webkit-app-region: drag）换掉：
     卡片贴进桌面层后是 Progman 的子窗口（WS_CHILD）。系统那套"非客户区拖动"
     在子窗口上要么根本不进移动循环（按住拖，窗口一动不动），要么进得很勉强
     —— 用户实测就是"跟着跑但慢半拍、还一闪一闪"。
     子窗口本身完全能移动（原生 SetWindowPos 实测 6/6 帧跟手），所以自己搬。

   为什么不让页面算位移再逐帧 IPC：窗口一动，渲染进程的 mousemove 就被节流，
   事件挤成一团；再叠一次进程往返，手感必然慢。这里主进程每 8ms 读一次系统光标，
   直接 SetWindowPos —— 延迟只剩一个定时器周期。

   全程物理像素：GetCursorPos / GetWindowRect / SetWindowPos 同一套坐标系，
   不做 DIP 换算（200% 缩放下算错就是走一半）。
   位置用"原点 + 光标总位移"，不逐帧累加，避免取整误差越攒越偏。 */
const _drg = (() => {
  try {
    const u = require("koffi").load("user32.dll");
    return {
      GetCursorPos: u.func("GetCursorPos", "bool", ["void *"]),
      GetWindowRect: u.func("GetWindowRect", "bool", ["void *", "void *"]),
      SetWindowPos: u.func("SetWindowPos", "bool", ["void *", "void *", "int", "int", "int", "int", "uint32"]),
      GetAsyncKeyState: u.func("GetAsyncKeyState", "int16", ["int"]),
      SetWindowDisplayAffinity: u.func("SetWindowDisplayAffinity", "bool", ["void *", "uint32"]),
      /* 判"现在前台是不是桌面本体"用（见 fgIsDesktop） */
      GetForegroundWindow: u.func("GetForegroundWindow", "void *", []),
      GetClassNameW: u.func("GetClassNameW", "int", ["void *", "uint16_t *", "int"]),
    };
  } catch (e) { return null; }
})();
const WDA_EXCLUDE = 0x11;   /* WDA_EXCLUDEFROMCAPTURE：对屏幕捕获隐身、照常显示 */

const SWP_DRAG = 0x0001 | 0x0004 | 0x0010;   /* NOSIZE | NOZORDER | NOACTIVATE */
const DRAG_THRESHOLD = 4;                    /* 物理像素，手抖不算拖 */

function hwndNum(win) {
  try {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch (e) { return 0; }
}

/* ================= 搜索层的两个"系统级"出口 =================
   以前退出搜索有两条路，都在页面里：
     · ESC —— document keydown；
     · 点桌面空白 —— 窗口失焦 → window blur。
   贴进桌面层之后两条全断了：卡片成了 Progman 的子窗口，
   既拿不到键盘焦点（一个 keydown 都收不到），也不存在"失焦"这回事
   （它没有前台身份，点桌面不会让它 blur）。用户就这么被关在搜索页里出不来。

   所以这活儿挪到主进程：搜索层开着的时候 40ms 轮一次
     · ESC 的上升沿
     · 左键的上升沿 + 光标不在窗口矩形里
   命中就通知页面 closeSearch。页面里还留着右上角的叉做第三道保险。 */
let searchOpen = false;
function watchSearchExit() {
  if (!_drg) return;
  let escPrev = false, lbPrev = false;
  setInterval(() => {
    const escDown = (_drg.GetAsyncKeyState(0x1B) & 0x8000) !== 0;
    const lbDown = (_drg.GetAsyncKeyState(0x01) & 0x8000) !== 0;
    const escEdge = escDown && !escPrev;
    const lbEdge = lbDown && !lbPrev;
    escPrev = escDown; lbPrev = lbDown;
    if (!searchOpen) return;
    const w = weatherWin;
    if (!w || w.isDestroyed()) return;
    let fire = escEdge;
    if (!fire && lbEdge) {
      const p = screen.getCursorScreenPoint();   /* DIP，与 getBounds 同一套 */
      const b = w.getBounds();
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (!inside) fire = true;
    }
    if (!fire) return;
    searchOpen = false;
    try { w.webContents.send("wgt:search-exit"); } catch (e) {}
  }, 40);
}

/* ================= 桌面快照背景（与待办卡同款，见 backdrop.js 头注释） =================
   半透明处要"透出桌面图标"，桌面层里真透明只能透壁纸，所以把快照垫在卡片底下。
   这里只管裁剪/下发，抓图在 backdrop.js。 */
let BD = null;
let bdTimer = null;
const BD_PAD = 44;

const hwndOf = (w) => {
  try {
    const b = w.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch (e) { return 0; }
};

function bdPayload() {
  const w = weatherWin;
  if (!w || w.isDestroyed() || !BD || !BD.has()) return null;
  const b = w.getBounds();
  let dpi = 1, zoom = 1;
  try { dpi = screen.getDisplayMatching(b).scaleFactor || 1; } catch (e) {}
  try { zoom = w.webContents.getZoomFactor() || 1; } catch (e) {}
  const s = dpi * zoom;               /* 物理 px ↔ CSS px 的总比例 */
  return BD.patch(
    { x: b.x * dpi, y: b.y * dpi, width: b.width * dpi, height: b.height * dpi },
    s, BD_PAD
  );
}

function pushBackdrop(delay) {
  clearTimeout(bdTimer);
  bdTimer = setTimeout(() => {
    const w = weatherWin;
    if (!w || w.isDestroyed()) return;
    if (w.__drag) return;                 /* 拖动中位置一直在变，松手后再给 */
    const p = bdPayload();
    if (!p) return;
    try { w.webContents.send("wgt:backdrop", p); } catch (e) {}
  }, delay == null ? 160 : delay);
}

/* 拖动中专用：无视 __drag 闸门立刻裁一块推给页面（拖动实况背景靠它） */
function pushBackdropNow() {
  const w = weatherWin;
  if (!w || w.isDestroyed()) return;
  const p = bdPayload();
  if (!p) return;
  try { w.webContents.send("wgt:backdrop", p); } catch (e) {}
}

/* 拖动实况背景：整幅快照一次性下发（PNG 几 MB，一次拖动只发一回；
   页面缓存 blob）。拖动中每 tick 只发窗口坐标，页面自己挪整幅快照 ——
   旧方案每 70ms 重裁一块，两次推送之间卡片动了背景没动，拖快了错位。 */
function sendBdFull(w) {
  if (!BD || !BD.has() || !w || w.isDestroyed()) return false;
  const f = BD.full();
  const png = BD.image();
  if (!f || !png) return false;
  try { w.webContents.send("wgt:bd-full", { png, ox: f.ox, oy: f.oy, w: f.w, h: f.h }); return true; }
  catch (e) { return false; }
}

function setCaptureAffinity(w, on) {
  if (!_drg || !_drg.SetWindowDisplayAffinity) return false;
  const hwnd = w && !w.isDestroyed() ? hwndOf(w) : 0;
  if (!hwnd) return false;
  try { return !!_drg.SetWindowDisplayAffinity(hwnd, on ? WDA_EXCLUDE : 0); } catch (e) { return false; }
}

function refreshSnapshot(reason) {
  const w = weatherWin;
  if (!w || w.isDestroyed() || !BD) return false;
  if (w.__drag) return false;
  const wda = setCaptureAffinity(w, true);
  let ok = false;
  try {
    ok = BD.capture({ hide: !wda, noHide: wda });
  } finally {
    if (wda) setCaptureAffinity(w, false);
  }
  if (ok) pushBackdrop(40);
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
      new Date().toISOString() + ` snapshot ${ok ? "OK" : "FAIL"} wda=${wda} (${reason || ""})\n`);
  } catch (e) {}
  return ok;
}

/* 背景"实时"化：★ v1.0.17 重做（原因：卡片会在桌面上"闪一下"）
   抓一张"干净桌面"必须让卡片消失 60~70ms —— WDA_EXCLUDEFROMCAPTURE 对
   Progman 子窗口无效（实测 wda=false），只能退回 SW_HIDE。所以关键不在
   "怎么抓"而在"多久抓一次"。旧策略是"20 秒无条件抓一次 + 每次松开鼠标都抓"，
   等于卡片每 20 秒自己消失一下。现在按事件抓：
     · 换壁纸（TranscodedWallpaper 的 mtime 变了）→ 抓（用户正在设置界面里，
       桌面被挡住，看不见闪）；
     · 改分辨率 / 缩放 → 抓；
     · 在**桌面上**松开左键 → 抓，60 秒最多一次；
     · 点应用窗口 → 不抓（卡片被盖着，抓了也看不见）；
     · 手动菜单「刷新桌面背景」→ 抓。 */
let _snapT = null, _snapLast = 0;

const _fgClsBuf = Buffer.alloc(512);
const DESK_FG_CLASSES = ["Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32"];

function fgIsDesktop() {
  if (!_drg || !_drg.GetForegroundWindow) return false;
  try {
    const n = _drg.GetClassNameW(_drg.GetForegroundWindow(), _fgClsBuf, 256);
    if (!(n > 0)) return false;
    return DESK_FG_CLASSES.indexOf(_fgClsBuf.toString("utf16le", 0, n * 2)) >= 0;
  } catch (e) { return false; }
}

const wallpaperFile = () =>
  path.join(app.getPath("appData"), "Microsoft", "Windows", "Themes", "TranscodedWallpaper");
function wallpaperStamp() {
  /* 修改时间 + 大小：Windows 换壁纸会重写 TranscodedWallpaper，
     两个值一起比，比只看 mtime 更稳（同一张图重新应用也能识别）。 */
  try {
    const s = fs.statSync(wallpaperFile());
    return (s.mtimeMs || 0) + ":" + (s.size || 0);
  } catch (e) { return 0; }
}

function scheduleSnapshot(delay, reason) {
  clearTimeout(_snapT);
  _snapT = setTimeout(() => {
    const now = Date.now();
    if (now - _snapLast < 900) return;
    _snapLast = now;
    refreshSnapshot(reason);
  }, delay == null ? 400 : delay);
}

let _clickSnap = 0, _wpStamp = 0;

function startDesktopWatch() {
  if (!_drg) return;
  _wpStamp = wallpaperStamp();

  let prev = false;
  setInterval(() => {
    const down = (_drg.GetAsyncKeyState(0x01) & 0x8000) !== 0;
    if (down === prev) return;
    prev = down;
    if (down) return;
    const w = weatherWin;
    if (!w || w.isDestroyed() || w.__drag) return;
    const p = screen.getCursorScreenPoint(), b = w.getBounds();
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return;
    if (!fgIsDesktop()) return;
    const now = Date.now();
    if (now - _clickSnap < 60000) return;
    _clickSnap = now;
    scheduleSnapshot(400, "desktop-click");
  }, 60);

  setInterval(() => {
    const s = wallpaperStamp();
    if (!s || s === _wpStamp) return;
    _wpStamp = s;
    scheduleSnapshot(500, "wallpaper");
  }, 2000);

  try { screen.on("display-metrics-changed", () => scheduleSnapshot(800, "metrics")); } catch (e) {}

  if (!_wpStamp) setInterval(() => scheduleSnapshot(0, "tick"), 600000);
}

/* ================= 窗口圆角裁剪（SetWindowRgn） =================
   症状：四角出现黑色三角。来源：卡片圆角外的像素是"没画的 alpha=0"，桌面层
   子窗口合成时这些像素变黑（DWM 的 DONOTROUND 属性对子窗口设置直接 E_HANDLE，
   没法用）。办法与待办卡同款：把窗口裁成圆角矩形，弧线外的像素根本不存在。
   只裁卡片本体 —— 四周 22px 自绘投影边距会被裁掉，桌面层里本来也看不见它。 */
const _rgn = (() => {
  try {
    const k = require("koffi");
    const u = k.load("user32.dll"), g = k.load("gdi32.dll");
    return {
      SetWindowRgn: u.func("SetWindowRgn", "int", ["void *", "void *", "bool"]),
      GetWindowRgn: u.func("GetWindowRgn", "int", ["void *", "void *"]),
      CreateRoundRectRgn: g.func("CreateRoundRectRgn", "void *", ["int", "int", "int", "int", "int", "int"]),
      DeleteObject: g.func("DeleteObject", "bool", ["void *"]),
    };
  } catch (e) { return null; }
})();

/* 区域看门狗：任何原因导致窗口区域丢失（SetParent、样式重建、全屏切换…），
   2 秒内补回来。倒计时卡同款，代价极小（一次 GetWindowRgn 调用）。 */
function startRegionWatch() {
  if (!_rgn || !_rgn.GetWindowRgn) return;
  setInterval(() => {
    const w = weatherWin;
    if (!w || w.isDestroyed()) return;
    try {
      const probe = _rgn.CreateRoundRectRgn(0, 0, 1, 1, 1, 1);
      const had = _rgn.GetWindowRgn(hwndNum(w), probe);
      _rgn.DeleteObject(probe);
      if (had === 0) { applyCardRegion(w); evlogSafe("region restored"); }
    } catch (e) {}
  }, 2000);
}

function applyCardRegion(w) {
  if (!_rgn || !w || w.isDestroyed()) {
    return;
  }
  const b = w.getBounds();
  let dpi = 1, zoom = 1;
  try { dpi = screen.getDisplayMatching(b).scaleFactor || 1; } catch (e) {}
  try { zoom = w.webContents.getZoomFactor() || 1; } catch (e) {}
  const s = dpi * zoom;
  /* ★ 裁切矩形必须等于"卡片真实占的地方"，不是窗口减 PAD。
     页面里 .card 是 position:absolute; inset:0 —— 卡片铺满整个窗口，
     并没有给投影留边距（#bd 才是往外扩 44px 那层）。
     原来按 PAD=22 缩进，实测把卡片四边各切掉 22 CSS px（窗口 582x598，
     可见区域只有 512x528），连左右两边的文字都被切了 —— 用户看到的"显示不全"。
     磨砂模式 PAD 本来就是 0，所以只有"贴进桌面"这条路上会犯。 */
  const m = 0;
  const W = Math.round(b.width * dpi), H = Math.round(b.height * dpi);
  const rad = Math.max(2, Math.round(18 * s));   /* CSS border-radius:18px，必须一致 */
  let hrgn = 0;
  try {
    /* ★ 最后两个参数是"椭圆的长和宽"，圆角半径 = 值 / 2。
       一直传 rad，实际圆角只有 CSS 的一半，窗口区域比卡片"方"，
       四个角会露出一条弧形缝（拖动时缝里是底下的桌面快照）。 */
    hrgn = Number(_rgn.CreateRoundRectRgn(
      m, m, W - m + 1, H - m + 1, rad * 2, rad * 2));
    /* ★ 原来写的是 hwndOf(w) —— 这个函数在天气卡里根本不存在，
       于是这里每次抛 ReferenceError、被 catch 吞掉，SetWindowRgn 从没执行过。
       圆角区域一直是"没设置"，窗口就是直角 → 四角露出 #bd 快照的浅色边。
       （1.1.0 那次改 rad*2 逻辑是对的，但函数在到达这一行之前就挂了。） */
    if (hrgn) _rgn.SetWindowRgn(hwndNum(w), hrgn, true);
  } catch (e) {}
}

function dragBegin(w) {
  dragStop(w, false);
  if (!_drg) return;
  const hwnd = hwndNum(w);
  const cb = Buffer.alloc(8), rb = Buffer.alloc(16);
  if (!hwnd || !_drg.GetCursorPos(cb) || !_drg.GetWindowRect(hwnd, rb)) return;
  const st = {
    hwnd,
    ox: rb.readInt32LE(0), oy: rb.readInt32LE(4),
    cx: cb.readInt32LE(0), cy: cb.readInt32LE(4),
    moving: false,
    timer: null,
  };
  w.__drag = st;
  /* 拖动实况背景（整幅快照方案）：起拖把整幅快照一次性发给页面，页面把它
     按屏幕坐标"钉死"在桌面上，之后每个 tick 只发一个窗口坐标 —— 背景不动、
     窗口在上面滑，像素级对齐。旧方案每 70ms 重裁一块，两次推送之间卡片
     动了背景没动，拖快了背景错位（用户报的"透明时和背景没对齐"）。
     快照是干净的（启动/20s 兜底抓的没有卡片自己），起手不抓图不闪屏。 */
  st.bd = !!(BD && BD.has());
  if (st.bd) {
    sendBdFull(w);
    try { w.webContents.send("wgt:bd-pos", { x: st.ox, y: st.oy }); } catch (e) { }
  }
  st.timer = setInterval(() => {
    if (w.isDestroyed()) { dragStop(w, true); return; }
    if ((_drg.GetAsyncKeyState(0x01) & 0x8000) === 0) { dragStop(w, true); return; }
    const c = Buffer.alloc(8);
    if (!_drg.GetCursorPos(c)) return;
    const dx = c.readInt32LE(0) - st.cx;
    const dy = c.readInt32LE(4) - st.cy;
    if (!st.moving) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      st.moving = true;
    }
    try { _drg.SetWindowPos(st.hwnd, 0, st.ox + dx, st.oy + dy, 0, 0, SWP_DRAG); } catch (e) { }
    /* 拖动实况背景：只发窗口新坐标，页面自己挪整幅快照（与窗口同源同步） */
    if (st.bd) { try { w.webContents.send("wgt:bd-pos", { x: st.ox + dx, y: st.oy + dy }); } catch (e) { } }
  }, 8);
}

function dragStop(w, persist) {
  const st = w.__drag;
  if (!st) return;
  clearInterval(st.timer);
  w.__drag = null;
  /* 拖动结束：让页面退出"整幅快照钉桌面"模式（随后 patch 载荷来重设 #bd） */
  if (st.bd) { try { w.webContents.send("wgt:bd-drag-end"); } catch (e) { } }
  /* 位置由原生 SetWindowPos 改的，等不到 moved 事件，必须自己落盘 */
  if (persist && w && !w.isDestroyed()) {
    const b = w.getBounds();
    patchState({ x: b.x, y: b.y });
    pushBackdrop(140);          /* 换位置了，快照重新裁一块 */
  }
}

/* ================= 桌面层输入桥（幽灵输入窗） =================
   卡片贴进桌面层后是 Progman 的子窗口 —— 子窗口永远进不了前台输入队列，
   键盘（含输入法）一个字都到不了页面，搜索框就成了摆设。
   解法：开一个**真顶层窗口**（能正常拿焦点、能起输入法），透明隐形，
   贴在搜索框的位置上代收打字，再把文字实时镜像回卡片。
   普通窗口模式键盘本来就是通的，主进程直接忽略 ime-begin。 */
let imeWin = null;        /* 幽灵输入窗（懒创建，常驻复用） */
let imeTarget = null;     /* 正在代收的那张卡片窗口 */
let imeHiding = false;    /* 自己 hide() 触发的 blur，别当成"用户点走了" */

function imeEnsure() {
  if (imeWin && !imeWin.isDestroyed()) return imeWin;
  imeWin = new BrowserWindow({
    width: 8, height: 8,
    frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false,
    show: false, alwaysOnTop: true,
    title: "输入桥",
    webPreferences: {
      preload: path.join(__dirname, "ime-preload.js"),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  imeWin.setMenu(null);
  imeWin.__loaded = false;
  imeWin.webContents.on("did-finish-load", () => {
    imeWin.__loaded = true;
    if (imeWin.__pending != null) {
      try { imeWin.webContents.send("ime:init", imeWin.__pending); } catch (e) {}
      imeWin.__pending = null;
    }
  });
  imeWin.loadFile(path.join(__dirname, "ime.html"));
  return imeWin;
}

/* 幽灵窗必须真正拿到系统前台，键盘才进得来。Windows 默认拒绝后台进程
   抢前台 —— 经典解锁手法：空按一次 ALT，系统就允许本进程把前台要回来。
   正常情况下用户刚点过卡片，第一次 focus 就能成；这里只是兜底。 */
function imeForceFocus(g) {
  let fgMe = false;
  try {
    const u = require("koffi").load("user32.dll");
    const GetForegroundWindow = u.func("GetForegroundWindow", "void *", []);
    const GetWindowThreadProcessId = u.func("GetWindowThreadProcessId", "uint32", ["void *", "uint32 *"]);
    const keybd_event = u.func("keybd_event", "void", ["uint8", "uint8", "uint32", "void *"]);
    const pidBuf = Buffer.alloc(4);
    const fgPid = () => {
      const fg = GetForegroundWindow();
      if (!fg) return 0;
      GetWindowThreadProcessId(fg, pidBuf);
      return pidBuf.readUInt32LE(0);
    };
    fgMe = fgPid() === process.pid;
    if (!fgMe) {
      keybd_event(0x12, 0, 0, null);       /* ALT down */
      keybd_event(0x12, 0, 2, null);       /* ALT up（KEYEVENTF_KEYUP） */
      try { g.focus(); } catch (e) {}
      fgMe = fgPid() === process.pid;
    }
  } catch (e) {}
  return fgMe;
}

function imeHide() {
  imeHiding = true;
  if (imeWin && !imeWin.isDestroyed()) {
    try { imeWin.hide(); } catch (e) {}
  }
  setTimeout(() => { imeHiding = false; }, 150);
}

function imeRelay(ch, v) {
  const w = imeTarget;
  if (!w || w.isDestroyed()) return;
  try { w.webContents.send(ch, v); } catch (e) {}
}

/* 在 app ready 之后注册一次（not per window） */
function registerImeIpc() {
  ipcMain.on("wgt:ime-begin", (e, r) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    if (desktopLayerOn() !== true) return;   /* 普通窗口模式键盘是通的 */
    const o = (r && typeof r === "object") ? r : {};
    const b = w.getBounds();
    /* 页面报的是窗口内 CSS px；本卡带 zoomFactor 缩放，css÷z=dip */
    let z = 1;
    try { z = w.webContents.getZoomFactor() || 1; } catch (er) {}
    const rect = {
      x: Math.round(b.x + (Number(o.x) || 0) / z),
      y: Math.round(b.y + (Number(o.y) || 0) / z),
      width: Math.max(8, Math.round((Number(o.w) || 8) / z)),
      height: Math.max(8, Math.round((Number(o.h) || 8) / z)),
    };
    const g = imeEnsure();
    imeTarget = w;
    try { g.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); } catch (er) {}
    const val = String(o.value || "");
    if (g.__loaded) {
      /* 幽灵窗常驻复用：隐藏着也要把预填值送过去，否则上次输入的文字
         会残留在框里，新一次打字接着旧文字往后拼。 */
      try { g.webContents.send("ime:init", val); } catch (er) {}
    } else {
      g.__pending = val;      /* 首次创建还没加载完，等 did-finish-load 再送 */
    }
    g.show();
    try { g.focus(); } catch (er) {}
    imeForceFocus(g);
  });
  ipcMain.on("wgt:ime-end", () => { imeHide(); imeTarget = null; });
  ipcMain.on("ime:text", (_e, v) => { if (!imeHiding) imeRelay("wx:ime-text", String(v == null ? "" : v)); });
  ipcMain.on("ime:commit", () => { imeHide(); imeRelay("wx:ime-commit"); });
  ipcMain.on("ime:cancel", () => { imeHide(); imeRelay("wx:ime-cancel"); });
  ipcMain.on("ime:blur", () => {
    if (imeHiding) return;               /* 自己藏起来的不算失焦 */
    imeHide();
    imeRelay("wx:ime-blur");
  });
}

/* ================= 卡片大小（等比缩放） =================
   做法：窗口尺寸 × z，同时 webContents 的 zoomFactor = z。
   页面是按"基准视口"排版的：窗口 DIP 宽 = 基准 × z，除以 zoomFactor 之后
   页面拿到的 CSS 宽还是基准值，于是字号、间距、图标跟着一起等比放大 ——
   而不是"框变大了、字还是原来那么大"。

   为什么不干脆 resizable:true 让用户拖边：
     卡片没有边框可抓，而且桌面层里窗口是 Progman 的子窗口，系统那套
     resize 边和标题栏拖动一样不工作（拖动已经因此改成自己实现了）。
     给档位菜单 + Ctrl+滚轮，两个入口都不依赖系统。

   缩放锚点是卡片中心：放大时四周均匀外扩，不会只往右下长。
   存 state.scale，重启后按原大小打开。 */
const SCALE_MIN = 0.7, SCALE_MAX = 1.6, SCALE_STEP = 0.05;
let scaleNow = 1;                     /* 缓存当前值：连按时免去反复读盘 */

/* 缩放的痕迹单独记一笔：出问题（尺寸不对、位置跑掉）时能一眼看到调了什么 */
function scaleLog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
      new Date().toISOString() + " " + msg + "\n");
  } catch (e) { /* 日志失败不影响功能 */ }
}

function clampScale(raw) {
  const v = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(v)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
}

function currentScale() {
  try { return clampScale(readState().scale); } catch (e) { return 1; }
}

/* ================= 四角拖拽缩放 =================
   等比：窗口尺寸 × z + zoomFactor = z，页面按基准视口排版，不用重算布局。
   角在右边 → 宽度跟光标；在左边 → 左边界跟光标、宽高反算。 */
function resizeStop(w) {
  if (!w || !w.__rz) return;
  const st = w.__rz;
  clearInterval(st.timer);
  w.__rz = null;
  /* 用最后一帧算出来的 z，不要用 getZoomFactor()：
     实测拖动刚结束那一刻它可能还是旧值，存下来会让重启后的尺寸对不上。 */
  try {
    const b = w.getBounds();
    const z = Number(st.lastZ);
    if (Number.isFinite(z) && z >= SCALE_MIN - 0.001) patchState({ x: b.x, y: b.y, scale: z });
  } catch (e) {}
}

function resizeBegin(w, corner) {
  resizeStop(w);
  const b = w.getBounds();
  const p0 = screen.getCursorScreenPoint();          /* Electron 给的是 DIP */
  const st = {
    corner, ox: b.x, oy: b.y, ow: b.width, oh: b.height,
    cx: p0.x, cy: p0.y,
    baseW: CARD_W + PAD * 2,
    timer: null,
  };
  w.__rz = st;
  st.timer = setInterval(() => {
    if (w.isDestroyed()) { resizeStop(w); return; }
    const p = screen.getCursorScreenPoint();
    const dx = p.x - st.cx;
    const right = corner === "tr" || corner === "br";
    const bottom = corner === "bl" || corner === "br";
    const z = clampScale((st.ow + (right ? dx : -dx)) / st.baseW);
    const nw = Math.round(st.baseW * z);
    const nh = Math.round((CARD_H + PAD * 2) * z);
    const nx = right ? st.ox : st.ox + (st.ow - nw);
    const ny = bottom ? st.oy : st.oy + (st.oh - nh);
    st.lastZ = z;
    try {
      w.webContents.setZoomFactor(z);
      w.setBounds({ x: nx, y: ny, width: nw, height: nh });
      applyCardRegion(w);
    } catch (e) {}
  }, 16);
}

function applyScale(raw) {
  const z = clampScale(raw);
  scaleNow = z;
  const w = weatherWin;
  if (!w || w.isDestroyed()) return z;

  const nw = Math.round((CARD_W + PAD * 2) * z);
  const nh = Math.round((CARD_H + PAD * 2) * z);
  const b = w.getBounds();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  let nx = Math.round(cx - nw / 2), ny = Math.round(cy - nh / 2);

  /* 夹回所在屏幕的可视区：贴着屏幕边放大时不至于跑出去 */
  const d = screen.getDisplayMatching({
    x: Math.round(cx), y: Math.round(cy), width: 1, height: 1,
  });
  const a = d.workArea;
  nx = Math.min(Math.max(nx, a.x + 8), a.x + a.width - nw - 8);
  ny = Math.min(Math.max(ny, a.y + 8), a.y + a.height - nh - 8);

  try { w.webContents.setZoomFactor(z); } catch (e) { }
  w.setBounds({ x: nx, y: ny, width: nw, height: nh });
  /* 左上角变了，位置一并落盘（和拖动同一个口径） */
  patchState({ x: nx, y: ny, scale: z });
  scaleLog(`scale ${z} -> ${nx},${ny} ${nw}x${nh}`);
  applyCardRegion(weatherWin);   /* 尺寸变了，圆角区域跟着重算 */
  pushBackdrop(220);             /* 快照位置也变了 */
  return z;
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

  const z = currentScale();
  scaleNow = z;
  const WIN_W = Math.round((CARD_W + PAD * 2) * z);
  const WIN_H = Math.round((CARD_H + PAD * 2) * z);

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
    roundedCorners: false,     /* Win11 给透明窗口自动加系统圆角，弧线外填黑（四角黑三角） */
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
      /* 等比缩放：窗口尺寸已经乘过 z，页面这边再乘 z 才是真实观感 */
      zoomFactor: z,
    },
  });

  weatherWin = w;   /* 之前漏了这一句：天气卡所有用到 weatherWin 的地方都拿不到窗口 */

  /* 桌面快照：赶在 show 之前抓（否则快照里嵌着卡片自己）。磨砂模式有真模糊，不用快照 */
  if (!USE_ACRYLIC) {
    const bdlog = (s) => {
      try {
        fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
          new Date().toISOString() + " " + s + "\n");
      } catch (e) {}
    };
    BD = createBackdrop({ getHwnd: () => hwndOf(w), log: bdlog });
    BD.capture({ hide: false });
  }

  if (top) w.setAlwaysOnTop(true, "floating");

  /* 事件留痕（%APPDATA%\WeatherCard\win-events.log）：窗口生命周期事件很罕见，
     一旦用户再报"卡片自己消失/弹出"，这就是精确现场。 */
  const evlogSafe = (msg) => {
    try {
      fs.appendFileSync(path.join(app.getPath("userData"), "win-events.log"),
        new Date().toISOString() + " " + msg + "\n");
    } catch (e) { /* 日志失败不影响功能 */ }
  };

  /* ---------- 智能置顶：Win+D「显示桌面」的唯一免疫手段 ----------
     本机实测（用 desktopCapturer 可信截图为证）：Win+D 会把所有**非置顶**窗口在
     合成层直接收走，而且不给 Electron 任何事件、IsWindowVisible 仍是 true、
     DwmGetWindowAttribute 的 cloak 仍为 0、渲染进程 visibilityState 仍是 visible
     —— 程序侧完全无感，靠事件反击不可能（试过 WS_EX_TOOLWINDOW 工具窗样式，无效）。
     唯一免疫的是置顶窗口（WS_EX_TOPMOST）。
     所以按需置顶：
       · 用户在菜单里勾了「窗口置顶」→ 一直置顶，本逻辑不插手；
       · 没勾 → 平时不置顶（老实待在别的窗口后面），只在「显示桌面」期间临时置顶，
         桌面收回去后立刻撤销。
     识别信号（实测）：显示桌面时前台窗口变成 Progman，屏幕中心落在桌面图标层
     （SysListView32）。只要屏幕中心被任何应用窗口（包括自家卡片）占着，就绝不置顶，
     避免平时乱冒头。 */
  let _win32 = null;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _win32 = {
      GetForegroundWindow: user32.func("GetForegroundWindow", "void *", []),
      GetClassNameW: user32.func("GetClassNameW", "int", ["void *", "uint16_t *", "int"]),
      GetTopWindow: user32.func("GetTopWindow", "void *", ["void *"]),
      GetWindow: user32.func("GetWindow", "void *", ["void *", "uint32"]),
      IsWindowVisible: user32.func("IsWindowVisible", "bool", ["void *"]),
      IsIconic: user32.func("IsIconic", "bool", ["void *"]),
      GetWindowLongW: user32.func("GetWindowLongW", "int", ["void *", "int"]),
      GetWindowThreadProcessId: user32.func("GetWindowThreadProcessId", "uint32", ["void *", "uint32 *"]),
    };
  } catch (e) { evlogSafe("koffi load err: " + e.message); }   /* 只影响 Win+D 免疫 */

  const DESKTOP_CLASSES = [
    "Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32",
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
    /* 系统壳窗口：显示桌面时它们照样可见，但不是"应用窗口"，别让它们把计数抬上去 */
    "PseudoConsoleWindow", "MonitorDisplayChange", "Xaml_WindowedPopupClass",
    "TopLevelWindowForOverflowXamlIsland", "ForegroundStaging",
  ];
  const _clsBuf = Buffer.alloc(512);
  const classNameOf = (h) => {
    try {
      const n = _win32.GetClassNameW(h, _clsBuf, 256);
      return n > 0 ? _clsBuf.toString("utf16le", 0, n * 2) : "";
    } catch (e) { return ""; }
  };
  const _pidBuf = Buffer.alloc(4);
  const pidOf = (h) => {
    try { _win32.GetWindowThreadProcessId(h, _pidBuf); return _pidBuf.readUInt32LE(0); } catch (e) { return 0; }
  };
  const isTopmost = (h) => {
    try { return (_win32.GetWindowLongW(h, -20) & 0x8) !== 0; } catch (e) { return false; }
  };
  const selfHwnd = () => {
    try {
      const b = w.getNativeWindowHandle();
      return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
    } catch (e) { return 0; }
  };

  /* 「显示桌面」判据（v1.0.6 重做）—— 旧做法取 3 个采样点问 WindowFromPoint「谁在最上面」，
     实测不可靠：Win+D 把窗口收走后，命中谁完全取决于当时的窗口布局，于是同一套代码
     时而判成"在显示桌面"（卡片一直置顶 → 飘在所有窗口前面），
     时而判成"不在"（卡片没置顶，被系统一起收走 → 消失）。用户两个症状都是它。
     新判据两条独立证据必须同时成立：
       ① 前台是桌面本体（Progman / WorkerW）；
       ② 屏幕上一扇"普通应用窗口"都不剩了 —— Win+D 会把这些窗口的 IsWindowVisible 直接置 false
          （实测：正常桌面能看到 6~8 扇；显示桌面时它们从可见列表消失，只剩桌面、任务栏、
           置顶窗口和桌面级挂件）。
     ② 正好解开「退出显示桌面、但焦点还留在桌面」这个死结：那一刻前台仍是 Progman，
     但窗口全都回来了 → 可见应用窗口数 > 2 → 判 false → 撤销置顶 + 沉底。
     置顶窗口必须排除，因为显示桌面时它们本来就还可见（包括我们自己的卡片）。 */
  const desktopIsShowing = () => {
    if (!_win32) return false;
    try {
      if (DESKTOP_CLASSES.indexOf(classNameOf(_win32.GetForegroundWindow())) < 0) return false;
      const me = process.pid;
      let apps = 0, guard = 0;
      let h = _win32.GetTopWindow(null);
      while (h && Number(h) !== 0 && guard++ < 400) {
        if (_win32.IsWindowVisible(h) && !_win32.IsIconic(h)) {
          const c = classNameOf(h);
          if (DESKTOP_CLASSES.indexOf(c) < 0 && pidOf(h) !== me && !isTopmost(h)) apps++;
        }
        h = _win32.GetWindow(h, 2);   /* GW_HWNDNEXT = 2 */
      }
      return apps <= 3;
    } catch (e) { return false; }
  };

  let _smartTopOn = null;

  /* ---------- 贴进桌面层（可选，默认关） ----------
     桌面快捷图标按 Win+D 不动，是因为它们不是窗口，而是住在桌面窗口 Progman 里面
     （Progman → SHELLDLL_DefView → SysListView32）。Win+D 只收顶层应用窗口，不碰这棵树。
     想同等待遇，唯一办法是把自己 SetParent 进 Progman（详见 desktop-layer.js）。
     挂上之后就不需要下面那套轮询判断「是不是在显示桌面」了。 */
  const dl = createDesktopLayer({ getWin: () => w, log: evlogSafe });
  DL = dl;   /* 给 sinkWin / restoreTop / wgt:raise 用：它们必须先问"是不是在桌面层里" */
  /* 桌面层里的"谁在前面"由主进程按光标坐标决定。
     为什么不用页面里的 mouseenter：挂进 Progman 之后页面收不到鼠标进入事件（实测
     WindowFromPoint 落在 Progman 本体上），页面那套 hover 抬升等于失效。
     几何判断不看遮挡，但两张卡都在桌面层、都被应用窗口盖住时，抬一下也无害。 */
  if (dl.available) {
    let inside = null;
    setInterval(() => {
      if (w.isDestroyed() || !dl.isOn()) { inside = null; return; }
      const p = screen.getCursorScreenPoint();
      const b = w.getBounds();
      const now = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (now === inside) return;
      inside = now;
      if (now) dl.raise();
    }, 120);
  }
  /* 区域看门狗：启动后就跑，任何原因丢了圆角都在 2 秒内补回来 */
  startRegionWatch();

  /* 勾了「窗口置顶」就不进桌面层（子窗口置顶无效，两者互斥） */
  if (dl.available && desktopLayerOn() && !top) {
    w.once("show", () => setTimeout(() => {
      if (!desktopLayerOn()) return;
      dl.set(true).then((ok) => {
        evlogSafe("dlayer startup " + ok);
        /* ★ SetParent 挂进 Progman 会把窗口区域清掉（实测 GetWindowRgn 从 2 变 0），
           不补回来窗口就是直角 —— 四角露出 #bd 快照那层浅色边（用户截图那个）。
           倒计时卡早就有这段补刀，天气卡一直缺。 */
        try { applyCardRegion(w); } catch (e) {}
        setTimeout(() => { try { applyCardRegion(w); } catch (e) {} }, 400);
      });
    }, 700));
  }
  if (dl.available) {
    setInterval(() => { if (desktopLayerOn()) dl.ensure(); }, 3000);
  }

  const applyTop = (on) => {
    if (w.isDestroyed()) return;
    try {
      if (on) w.setAlwaysOnTop(true, "floating");
      else {
        w.setAlwaysOnTop(false);
        setTimeout(() => sinkWin(w), 60);   /* 撤销置顶≠沉下去，见 sinkWin 的说明 */
      }
    } catch (e) { /* 切换失败不影响其他功能 */ }
  };
  if (_win32) {
    let tick = 0;
    let wantTop = top;
    setInterval(() => {
      if (w.isDestroyed()) return;
      if (dl.isOn()) { _smartTopOn = null; return; }   /* 已在桌面层，不需要置顶这套 */
      tick++;
      if ((tick % 5) === 0) {            /* 每 ~1s 读一次用户设置：够快，也不折腾磁盘 */
        try { wantTop = readState().top === true; } catch (e) { /* 读不到就沿用上次 */ }
      }
      if (wantTop) { _smartTopOn = null; return; }   /* 用户要常驻置顶：交给设置，不插手 */
      const showing = desktopIsShowing();
      const curTop = isTopmost(selfHwnd());
      if ((tick % 25) === 0) {           /* 每 ~5s 一条心跳：再出问题可以直接看现场 */
        evlogSafe(`tick showing=${showing} top=${curTop} fg=${classNameOf(_win32.GetForegroundWindow())}`);
      }
      _smartTopOn = showing;
      /* 幂等校正：不看"上一轮判过什么"，只看"这一轮该不该置顶"。
         状态机一旦被外部改乱（系统在切换瞬间强行隐藏/置顶窗口），这里每 200ms 拉回一次。 */
      if (showing && !curTop) { evlogSafe("apply ON  fg=" + classNameOf(_win32.GetForegroundWindow())); applyTop(true); }
      else if (!showing && curTop) { evlogSafe("apply OFF fg=" + classNameOf(_win32.GetForegroundWindow())); applyTop(false); }
    }, 200);
  }

  /* 窗口事件留痕 */
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

  /* zoom 会被导航/重载重置，所以在加载完成后再压几次，并记下真实生效值 */
  const applyZoom = (tag) => {
    try {
      const want = currentScale();
      w.webContents.setZoomFactor(want);

    } catch (e) { evlogSafe("zoom err " + e.message); }
  };
  w.webContents.on("did-finish-load", () => { applyZoom(); setTimeout(applyZoom, 400); });

  w.once("ready-to-show", () => {
    /* ★ zoom 必须在页面加载完成后再设一次。
       加载前调 setZoomFactor 会被导航重置回 1：窗口按 scale 缩小了，
       页面却还是 100% 渲染 → 320x330 的卡片塞进 230x238 的窗口，
       底部内容被裁、四角被窗口边界切掉（用户看到的"信息显示不全 + 四角白边"）。 */
    try { w.webContents.setZoomFactor(currentScale()); } catch (e) {}
    w.show();
    pushBackdrop(260);
    applyCardRegion(w);       /* 圆角外的黑三角：窗口裁成圆角矩形后就不存在了 */
  });

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
    { label: "外观设置（透明度 / 磨砂）", click: () => weatherWin && weatherWin.webContents.send("wx:show-look") },
    { label: "刷新桌面背景", click: () => refreshSnapshot("menu") },
    { type: "separator" },
    {
      /* 档位给固定的几个就够；微调用这里的放大/缩小或 Ctrl+Alt+↑↓。
         注意：桌面层模式下 Ctrl+滚轮收不到 —— Windows 只把滚轮消息发给
         拥有焦点的窗口，而贴进桌面的卡片是 Progman 的子窗口、拿不到焦点。
         所以主入口做成菜单项 + 全局快捷键，这两个不依赖焦点。 */
      label: `卡片大小（当前 ${Math.round(currentScale() * 100)}%）`,
      submenu: [
        { label: "放大 5%", click: () => applyScale(scaleNow + SCALE_STEP) },
        { label: "缩小 5%", click: () => applyScale(scaleNow - SCALE_STEP) },
        { type: "separator" },
        ...[0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5].map((z) => ({
          label: Math.round(z * 100) + "%" + (z === 1 ? "（标准）" : ""),
          type: "radio",
          checked: Math.abs(currentScale() - z) < 0.005,
          click: () => applyScale(z),
        })),
      ],
    },
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
      label: "贴进桌面（和桌面图标同层）",
      type: "checkbox",
      checked: st.desktopLayer === true,
      click: (item) => { toggleDesktopLayer(item.checked); },
    },
    {
      label: "窗口置顶（会脱离桌面层）",
      type: "checkbox",
      checked: onTop,
      click: async (item) => {
        patchState({ top: item.checked });
        const w = weatherWin;
        if (!w || w.isDestroyed()) return;
        /* 贴进桌面层时是 Progman 的子窗口，setAlwaysOnTop 对子窗口无效 ——
           要真浮到最前必须先脱离桌面层（两者天然互斥）。 */
        if (item.checked) {
          patchState({ desktopLayer: false });
          try { if (DL && DL.isOn && DL.isOn()) await DL.set(false); } catch (e) {}
          try { w.setAlwaysOnTop(true, "floating"); } catch (e) {}
        } else {
          patchState({ desktopLayer: true });
          try { w.setAlwaysOnTop(false); } catch (e) {}
          try { if (DL) await DL.set(true); } catch (e) {}
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
  /* 这里才定磨砂/投影边距：贴进桌面层时系统磨砂不可用，必须改走透明自绘 */
  USE_ACRYLIC = acrylicSupported() && !desktopLayerOn();
  PAD = USE_ACRYLIC ? 0 : 22;
  maybeMigrateLegacy();
  createWindow();
  startDesktopWatch();   /* 桌面上松开左键 / 20 秒兜底 → 重抓快照 */
  registerImeIpc();      /* 桌面层里子窗口拿不到键盘焦点，搜索框靠幽灵输入窗代收 */

  /* 快捷键兜底：贴进桌面后万一看不见，Ctrl+Alt+2 一键切回普通窗口（会重启自己） */
  try {
    globalShortcut.register("Control+Alt+2", () => toggleDesktopLayer(!desktopLayerOn()));
  } catch (e) { /* 注册失败不影响其它功能 */ }

  /* 缩放快捷键：Ctrl+Alt+↑ 放大 / Ctrl+Alt+↓ 缩小（5% 一档）。
     桌面层里卡片拿不到焦点，滚轮消息根本不会投给它，所以必须走全局快捷键。 */
  const zoomKeys = [
    ["Control+Alt+Up", SCALE_STEP],
    ["Control+Alt+Down", -SCALE_STEP],
  ];
  for (const [acc, delta] of zoomKeys) {
    try {
      const ok = globalShortcut.register(acc, () => applyScale(scaleNow + delta));
      scaleLog("hotkey " + acc + " = " + ok);
    } catch (e) { scaleLog("hotkey " + acc + " threw " + e.message); }
  }

  const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);

  /* 拖动整张卡（页面只报按下/松开，位移由主进程跟着系统光标搬，见 dragBegin 说明） */
  ipcMain.on("wgt:drag-begin", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    dragBegin(w);
  });

  ipcMain.on("wgt:resize-begin", (e, corner) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) resizeBegin(w, String(corner || "br"));
  });
  ipcMain.on("wgt:resize-end", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) resizeStop(w);
  });

  ipcMain.on("wgt:drag-end", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    dragStop(w, true);
  });

  /* ---------- 桌面快照背景 + 外观（透明度/磨砂，与待办卡同款） ---------- */
  ipcMain.handle("wgt:backdrop-now", () => bdPayload());
  ipcMain.handle("wgt:get-look", () => readState().look || null);
  ipcMain.handle("wgt:set-look", (e, v) => {
    const o = (v && typeof v === "object") ? v : {};
    const look = {
      alpha: Math.min(1, Math.max(0.1, Number(o.alpha) || 1)),   /* 底色浓度，1=现状（不透明渐变） */
      frost: Math.min(20, Math.max(0, Number(o.frost) || 0)),    /* 快照模糊半径 px */
    };
    patchState({ look });
    /* ★ 必须推回页面：之前只存了状态，页面完全不知道 ——
       从 Ctrl+滚轮 微调（走主进程）改的透明度/磨砂要重启才生效，
       用户看到的就是"透明度跟磨砂都失效了"。 */
    try { if (weatherWin && !weatherWin.isDestroyed()) weatherWin.webContents.send("wgt:look", look); } catch (e) {}
    return look;
  });

  /* Ctrl+滚轮：5% 一档。档位菜单太粗，这个用来微调 */
  ipcMain.on("wgt:scale-step", (e, dir) => {
    if (weatherWin && weatherWin.isDestroyed()) return;
    applyScale(scaleNow + (Number(dir) > 0 ? SCALE_STEP : -SCALE_STEP));
  });

  /* 搜索层开/关：开着的时候主进程替它盯 ESC 和"点窗口外"（见 watchSearchExit） */
  ipcMain.on("wgt:search-state", (e, on) => { searchOpen = !!on; });
  watchSearchExit();

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
        restoreTop(w);
      },
    });
  });

  /* ---------- 鼠标指上来就临时浮到最前 ----------
     按"点一下"才浮上来太迟钝；hover 即抬升、移开即还原 —— 都是临时的，
     不写进存档，用户自己在菜单里设的"窗口置顶"不能被它改掉。 */
  ipcMain.on("wgt:raise", (e) => {
    const w = senderWin(e);
    if (!w || w.isDestroyed()) return;
    /* 桌面层里：只把自己的兄弟 z 序抬到最前（这样鼠标指哪张卡、哪张卡就在上面，
       不会出现"待办永远压在天气后面"）。绝不能 setAlwaysOnTop —— 子窗口置顶无意义，
       而且下一次"撤销置顶"会把卡片沉进图标层后面（就是消失的那个 bug）。 */
    if (DL && DL.isOn()) { DL.raise(); return; }
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
    if (DL && DL.isOn()) return;   /* 桌面层里鼠标移开也不还原层级：一还原就是沉底 = 消失 */
    w.__hoverTop = false;
    if (w.__menuOpen) { w.__restPending = true; return; }   /* 菜单还开着，等它关了再沉 */
    restoreTop(w);
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

app.on("will-quit", () => {
  try { globalShortcut.unregisterAll(); } catch (e) { /* 无所谓 */ }
});
