"use strict";
/* ============ 桌面快照背景（backdrop） ============
   要解决的问题：卡片贴进桌面层后，半透明的地方**只能透出壁纸，透不出桌面图标**。
   两条更"正规"的路都试过了、都不通（详见 desktop-layer.js 文件头的实测记录）：
     · 挂到画图标的 SysListView32 下面 → 图标依然不出现（像素相关度 0.08）
     · SetWindowBand 把顶层窗口塞进桌面档位 → 窗口直接不可见
   所以改用"快照"：PrintWindow(Progman, PW_RENDERFULLCONTENT) 能把**壁纸+图标**
   整幅画出来（不受别的窗口遮挡影响），把卡片底下那一块裁出来当作卡片自己的背景。
   视觉上就是图标透过半透明卡片露出来 —— 顺带让"磨砂"有了真东西可以模糊
   （真透窗里 backdrop-filter 是模糊不了桌面的）。

   几个必须知道的点：
     1) PrintWindow 抓的是 Progman 的**整棵树**，卡片自己是 Progman 的子窗口，
        抓的时候必须先把卡片藏起来（SW_HIDE），抓完立刻恢复 —— 全过程约 60ms，
        所以只在启动（卡片还没 show）和用户手动"刷新背景"时做，平时只裁缓存。
     2) 裁剪要向外多留一圈（pad），否则磨砂在边缘会模糊到"图外"，
        露出下面那层没模糊的壁纸，看着像一圈毛边。
     3) 快照是**静态**的：图标挪了、换壁纸了，背景就会和真实桌面不一致，
        要点菜单里的"刷新桌面背景"。这是这个方案的代价，写在这里免得以后当bug查。 */

function api() {
  try {
    const koffi = require("koffi");
    const u = koffi.load("user32.dll");
    const g = koffi.load("gdi32.dll");
    return {
      FindWindowW: u.func("FindWindowW", "void *", ["str16", "str16"]),
      GetWindowRect: u.func("GetWindowRect", "bool", ["void *", "void *"]),
      GetDC: u.func("GetDC", "void *", ["void *"]),
      ReleaseDC: u.func("ReleaseDC", "int", ["void *", "void *"]),
      PrintWindow: u.func("PrintWindow", "bool", ["void *", "void *", "uint32"]),
      ShowWindow: u.func("ShowWindow", "bool", ["void *", "int"]),
      CreateCompatibleDC: g.func("CreateCompatibleDC", "void *", ["void *"]),
      CreateCompatibleBitmap: g.func("CreateCompatibleBitmap", "void *", ["void *", "int", "int"]),
      SelectObject: g.func("SelectObject", "void *", ["void *", "void *"]),
      DeleteObject: g.func("DeleteObject", "bool", ["void *"]),
      DeleteDC: g.func("DeleteDC", "bool", ["void *"]),
      GetDIBits: g.func("GetDIBits", "int", ["void *", "void *", "uint32", "uint32", "void *", "void *", "uint32"]),
    };
  } catch (e) { return null; }
}

const PRENDER_FULL = 2;   /* PW_RENDERFULLCONTENT：走 DWM，普通 PrintWindow 抓不到图标 */

function createBackdrop({ getHwnd, log }) {
  const a = api();
  const say = (s) => { try { log("backdrop " + s); } catch (e) {} };
  const st = { img: null, ox: 0, oy: 0, w: 0, h: 0 };

  /* 抓整幅桌面（壁纸+图标）。visible=true 时抓的画面里会带着卡片自己，
     所以先把它 SW_HIDE 掉，抓完立刻恢复。
     noHide=true 表示调用方已经让卡片"对捕获隐身"（WDA_EXCLUDEFROMCAPTURE），
     这时不用藏 —— 换来的是不闪、可以高频重抓（实时背景靠它）。 */
  const capture = (opts) => {
    if (!a) { say("no koffi"); return false; }
    const noHide = !!(opts && opts.noHide);
    const hide = !!(opts && opts.hide) && !noHide;
    const { nativeImage } = require("electron");
    const t0 = Date.now();
    let prog = 0;
    try { prog = Number(a.FindWindowW("Progman", null)) || 0; } catch (e) {}
    if (!prog) { say("no progman"); return false; }

    const rb = Buffer.alloc(16);
    if (!a.GetWindowRect(prog, rb)) { say("no rect"); return false; }
    const ox = rb.readInt32LE(0), oy = rb.readInt32LE(4);
    const W = rb.readInt32LE(8) - ox, H = rb.readInt32LE(12) - oy;
    if (W < 64 || H < 64) { say("bad rect " + W + "x" + H); return false; }

    let cardHidden = hide ? getHwnd() : 0;
    if (cardHidden) a.ShowWindow(cardHidden, 0);   /* SW_HIDE */
    let ok = false, lines = 0;
    let hdc = 0, mem = 0, bmp = 0, old = 0;
    try {
      hdc = a.GetDC(0);
      mem = a.CreateCompatibleDC(hdc);
      bmp = a.CreateCompatibleBitmap(hdc, W, H);
      old = a.SelectObject(mem, bmp);
      ok = a.PrintWindow(prog, mem, PRENDER_FULL);
      /* ★ 抓完立刻把卡片显示回来，**再**去读像素：GetDIBits 读的是内存位图，
         和窗口可见性无关。这样"卡片消失"的时长只剩 PrintWindow 那一下
         （实测 60~70ms，原先含 GetDIBits 要 70~90ms），闪烁短到几乎看不见。 */
      if (cardHidden) { a.ShowWindow(cardHidden, 5); cardHidden = 0; }
      /* BITMAPINFO 手拼 40 字节头：biHeight 取负 = 自上而下，省得再翻一遍 */
      const bi = Buffer.alloc(40 + 16);
      bi.writeUInt32LE(40, 0);
      bi.writeInt32LE(W, 4);
      bi.writeInt32LE(-H, 8);
      bi.writeUInt16LE(1, 12);
      bi.writeUInt16LE(32, 14);
      bi.writeUInt32LE(0, 16);
      const buf = Buffer.alloc(W * H * 4);
      lines = a.GetDIBits(mem, bmp, 0, H, buf, bi, 0);
      if (lines > 0) {
        st.img = nativeImage.createFromBitmap(buf, { width: W, height: H });
        st.ox = ox; st.oy = oy; st.w = W; st.h = H;
      }
    } catch (e) {
      say("capture err " + e.message);
    } finally {
      try {
        if (mem && old) a.SelectObject(mem, old);
        if (bmp) a.DeleteObject(bmp);
        if (mem) a.DeleteDC(mem);
        if (hdc) a.ReleaseDC(0, hdc);
      } catch (e) {}
      if (cardHidden) a.ShowWindow(cardHidden, 5);   /* SW_SHOW：异常路径也要还原 */
    }
    say(`capture ${ok && lines > 0 ? "OK" : "FAIL"} ${W}x${H} lines=${lines} ${Date.now() - t0}ms`);
    return lines > 0;
  };

  /* 裁出卡片那一块。x/y/w/h 是**物理像素**屏幕坐标；pad 是外扩（物理像素）。
     返回的 left/top/w/h 已经换算成 CSS px（相对窗口客户区左上角）。 */
  const patch = (rect, scale, pad) => {
    if (!st.img) return null;
    const s = scale || 1;
    const p = Math.max(0, Math.round(pad || 0));
    const px = Math.round(rect.x) - st.ox - p;
    const py = Math.round(rect.y) - st.oy - p;
    const pw = Math.round(rect.width) + p * 2;
    const ph = Math.round(rect.height) + p * 2;
    const x0 = Math.max(0, px), y0 = Math.max(0, py);
    const x1 = Math.min(st.w, px + pw), y1 = Math.min(st.h, py + ph);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 16 || ch < 8) return null;        /* 卡片跑到副屏/画面外了，不裁 */
    try {
      const crop = st.img.crop({ x: x0, y: y0, width: cw, height: ch });
      const png = crop.toPNG();
      /* left/top 是相对**窗口左上角**的偏移（不是相对外扩后的矩形）：
         正常情况就是 -pad，被屏幕边缘裁掉时会小一些。 */
      const wl = Math.round(rect.x) - st.ox;
      const wt = Math.round(rect.y) - st.oy;
      return {
        url: "data:image/png;base64," + png.toString("base64"),
        left: (x0 - wl) / s,
        top: (y0 - wt) / s,
        w: cw / s,
        h: ch / s,
      };
    } catch (e) {
      say("patch err " + e.message);
      return null;
    }
  };

  return {
    available: !!a,
    capture,
    patch,
    /* 拖动实况用：整幅快照的元数据 + PNG 原图。拖动中页面拿它当
       "钉在桌面上"的整幅背景，窗口在上面滑 —— 见 main.js dragBegin。 */
    full: () => st.img ? { ox: st.ox, oy: st.oy, w: st.w, h: st.h } : null,
    image: () => { if (!st.img) return null; try { return st.img.toPNG(); } catch (e) { return null; } },
    has: () => !!st.img,
  };
}

module.exports = createBackdrop;
