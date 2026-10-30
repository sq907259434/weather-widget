"use strict";
/* ============ 贴进桌面层（desktop layer） ============
   目的：让卡片和「桌面快捷图标」享受完全一样的待遇 —— 按 Win+D 不动、退出显示桌面
         也不会浮到别人窗口前面。

   为什么只有这一条路：
     桌面图标其实**不是窗口**，它们住在桌面窗口 Progman 内部
     （Progman → SHELLDLL_DefView → SysListView32）。Win+D 只收「顶层应用窗口」，
     从来不碰 Progman 这棵树，所以图标永远都在原位。
     也就是说：想和图标同层，就必须把自己变成 Progman 的子窗口（SetParent）。

   成为子窗口之后：
     · Win+D 不再影响它（父窗口没被收走，孩子自然也不动）；
     · 它永远待在桌面之上、任何应用窗口之下 —— 不必再靠 200ms 轮询去猜"现在是不是显示桌面"。

   ⚠ 实测坑（都踩过了，别再重复）：
     1) 改完 WS_CHILD 之后**不要**再调 SetWindowPos 传 DIP 尺寸 —— 那一刻窗口已经
        不做 DPI 虚拟化，尺寸参数是**物理像素**。传 300x180（本意 DIP）会把它缩成
        一半（本机 200% 缩放：显示 600x360 物理 → 变 300x180）。改样式+挂父窗口本身
        不会改变尺寸和位置，所以什么都不用设。
        （只改 z 序的 SetWindowPos 必须带 SWP_NOSIZE|SWP_NOMOVE，那就不会碰尺寸。）
     2) SetParent 有时是**延迟生效**的：改完样式那一瞬间 GetParent 还是 0，几百毫秒后
        才变成 Progman。所以校验必须等一会儿再做，不能当场判失败。
     3) Explorer 重启会连父窗口一起销毁 → 卡片会跟着消失，需要外面挂 relaunch 兜底。
     4) ★致命：挂上 Progman 之后，**任何** SetWindowPos(HWND_BOTTOM) 都会把卡片沉到
        SHELLDLL_DefView（铺满全屏的图标层）**下面** —— 从外面看就是「卡片自己消失了」，
        而 IsWindowVisible 还是 true、没有任何 hide 事件，日志里一片安静。
        实测证据（Explorer 的 Progman 子窗口顺序，0 = 最上）：
          沉底前 [0] 待办卡片  [4] SHELLDLL_DefView   → 看得见
          沉底后 [0] SHELLDLL_DefView  [5] 待办卡片   → 看不见
          再 HWND_TOP → [0] 待办卡片                 → 又看得见
        所以：桌面层模式下**绝对不许沉底**；需要"抬起"时用 raise()（HWND_TOP）。 */

const GWL_STYLE = -16, GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000, WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;
const WS_EX_TOOLWINDOW = 0x00000080, WS_EX_APPWINDOW = 0x00040000;
/* 只改 z 序：NOSIZE|NOMOVE|NOACTIVATE|NOOWNERZORDER。带上 NOSIZE/NOMOVE 就绝不会
   碰到尺寸和位置（见文件头坑 1）。 */
const SWP_ZORDER_ONLY = 0x0001 | 0x0002 | 0x0010 | 0x0200;
const GW_CHILD = 5, GW_HWNDNEXT = 2;

let _api;          /* undefined = 还没加载；null = 加载失败（非 Windows / 没装 koffi） */

function api() {
  if (_api !== undefined) return _api;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _api = {
      SetParent: user32.func("SetParent", "void *", ["void *", "void *"]),
      GetParent: user32.func("GetParent", "void *", ["void *"]),
      FindWindowW: user32.func("FindWindowW", "void *", ["str16", "str16"]),
      FindWindowExW: user32.func("FindWindowExW", "void *", ["void *", "void *", "str16", "str16"]),
      IsWindow: user32.func("IsWindow", "bool", ["void *"]),
      GetWindowLongW: user32.func("GetWindowLongW", "int32", ["void *", "int"]),
      SetWindowLongW: user32.func("SetWindowLongW", "int32", ["void *", "int", "int32"]),
      ShowWindow: user32.func("ShowWindow", "bool", ["void *", "int"]),
      GetWindow: user32.func("GetWindow", "void *", ["void *", "uint32"]),
      SetWindowPos: user32.func("SetWindowPos", "bool", ["void *", "void *", "int", "int", "int", "int", "uint32"]),
    };
  } catch (e) { _api = null; }
  return _api;
}

function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch (e) { return 0; }
}

/* 桌面图标层的宿主：优先 Progman（图标直接挂里面），否则找带 SHELLDLL_DefView 的 WorkerW */
function findHost(a) {
  try {
    const prog = a.FindWindowW("Progman", null);
    if (prog && Number(prog)) {
      if (a.FindWindowExW(prog, null, "SHELLDLL_DefView", null)) return Number(prog);
    }
    let cur = 0;
    for (let i = 0; i < 64; i++) {
      const ww = a.FindWindowExW(null, cur, "WorkerW", null);
      if (!ww || !Number(ww)) break;
      if (a.FindWindowExW(ww, null, "SHELLDLL_DefView", null)) return Number(ww);
      cur = ww;
    }
  } catch (e) { /* 桌面还没起来 */ }
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createDesktopLayer({ getWin, log }) {
  const say = (s) => { try { log("dlayer " + s); } catch (e) {} };
  const state = { on: false, host: 0, orig: null };

  /* 把卡片抬到兄弟窗口的最上面（= 压在 SHELLDLL_DefView 图标层之上）。
     只动 z 序，不动尺寸/位置/激活状态，所以不会踩文件头坑 1。 */
  const raise = () => {
    const win = getWin();
    const a = api();
    if (!a || !win || win.isDestroyed()) return false;
    const hwnd = hwndOf(win);
    if (!hwnd) return false;
    try {
      a.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_ZORDER_ONLY);   /* 0 = HWND_TOP */
      return true;
    } catch (e) { return false; }
  };

  /* 现在到底有没有被图标层盖住 —— 走兄弟窗口链：卡片排在 DefView 前面才算露出来。
     不能用 WindowFromPoint 判：正常桌面里应用窗口盖住卡片是**应该的**。 */
  const aboveIcons = (a, host, hwnd) => {
    try {
      const def = Number(a.FindWindowExW(host, null, "SHELLDLL_DefView", null));
      if (!def) return true;                 /* 找不到图标层就没法判，当作没被盖 */
      let h = Number(a.GetWindow(host, GW_CHILD));
      for (let i = 0; h && i < 200; i++) {
        if (h === hwnd) return true;
        if (h === def) return false;
        h = Number(a.GetWindow(h, GW_HWNDNEXT));
      }
      return true;
    } catch (e) { return true; }
  };

  const enter = async () => {
    const win = getWin();
    const a = api();
    if (!a || !win || win.isDestroyed()) return false;
    const host = findHost(a);
    if (!host) { say("host 未找到，放弃"); return false; }
    const hwnd = hwndOf(win);
    if (!hwnd) { say("hwnd 取不到"); return false; }

    if (!state.orig) {
      state.orig = {
        style: a.GetWindowLongW(hwnd, GWL_STYLE) >>> 0,
        ex: a.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0,
      };
    }

    /* 只改样式 + 挂父窗口，尺寸/位置一律不碰（碰了就按物理像素算，见文件头坑 1） */
    let st = a.GetWindowLongW(hwnd, GWL_STYLE) >>> 0;
    let ex = a.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0;
    st = ((st & ~WS_POPUP) | WS_CHILD | WS_VISIBLE) >>> 0;
    ex = ((ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW) >>> 0;
    a.SetWindowLongW(hwnd, GWL_STYLE, st | 0);
    a.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | 0);
    a.SetParent(hwnd, host);
    a.ShowWindow(hwnd, 5);   /* SW_SHOW */

    /* SetParent 可能延迟生效，等一等再判定 */
    let parent = 0;
    for (let i = 0; i < 6; i++) {
      await sleep(120);
      if (win.isDestroyed()) return false;
      parent = Number(a.GetParent(hwnd));
      if (parent === host) break;
    }
    const ok = parent === host;
    state.on = ok;
    state.host = ok ? host : 0;
    /* 挂上去之后立刻抬到兄弟窗口最上面：SetParent 插入的位置在各版本/各状态下滑稽地
       不稳定，一旦落在 DefView 后面就是「看得见进程、看不见卡片」。抬一次最保险。 */
    if (ok) raise();
    const b = ok ? win.getBounds() : null;
    say(`enter ${ok ? "OK" : "FAIL(parent=" + parent.toString(16) + ")"} host=0x${host.toString(16)}` +
        (b ? ` rect=${b.x},${b.y},${b.width}x${b.height}` : ""));
    return ok;
  };

  const leave = async () => {
    const win = getWin();
    const a = api();
    if (!a || !win || win.isDestroyed()) { state.on = false; return false; }
    const hwnd = hwndOf(win);
    if (!hwnd) { state.on = false; return false; }
    try { a.SetParent(hwnd, 0); } catch (e) {}
    if (state.orig) {
      a.SetWindowLongW(hwnd, GWL_STYLE, (state.orig.style | 0));
      a.SetWindowLongW(hwnd, GWL_EXSTYLE, (state.orig.ex | 0));
    }
    a.ShowWindow(hwnd, 5);
    state.on = false;
    state.host = 0;
    await sleep(150);
    say("leave OK");
    return true;
  };

  /* 看门狗：父子关系被冲掉就重建；宿主整个没了就退回顶层（宁可回到旧行为，也不能丢窗口） */
  const ensure = async () => {
    if (!state.on) return;
    const win = getWin();
    const a = api();
    if (!a || !win || win.isDestroyed()) return;
    const hwnd = hwndOf(win);
    if (!hwnd) return;
    const parent = Number(a.GetParent(hwnd));
    if (parent && a.IsWindow(parent)) {
      /* 关系还在，但可能被谁沉到图标层后面去了（系统的 z 序重排、Explorer 重建
         DefView 都会）—— 只在"真的被盖住"时才抬，两张卡片不会互相抢最上层。 */
      if (state.host && !aboveIcons(a, state.host, hwnd)) {
        say("ensure: 被图标层盖住，抬起");
        raise();
      }
      return;
    }
    const host = findHost(a);
    if (!host) { say("ensure: 宿主消失，退回顶层"); await leave(); return; }
    say("ensure: 关系丢失，重建");
    await enter();
  };

  const leaveQuiet = () => { if (state.on) Promise.resolve(leave()).catch(() => {}); };

  return {
    available: !!api(),
    isOn: () => state.on,
    set: async (want) => (want ? enter() : leave()),
    raise,
    ensure,
    leaveQuiet,
  };
}

module.exports = createDesktopLayer;
