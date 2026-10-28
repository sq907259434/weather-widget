const { contextBridge, ipcRenderer } = require("electron");

/* 是否使用系统磨砂：由主进程按 Windows 版本决定，通过启动参数传进来 */
const ACRYLIC = process.argv.some((a) => a === "--wgt-acrylic=1");
/* 当前窗口是哪张卡片：weather / todo */
const CARD = (process.argv.find((a) => a.startsWith("--wgt-card=")) || "--wgt-card=weather")
  .split("=")[1];

contextBridge.exposeInMainWorld("wgt", {
  acrylic: ACRYLIC,
  card: CARD,
  close: () => ipcRenderer.send("wgt:close"),
  menu: () => ipcRenderer.send("wgt:menu"),
  getTop: () => ipcRenderer.invoke("wgt:get-top"),
  setTop: (v) => ipcRenderer.invoke("wgt:set-top", v),
  /* 鼠标指上来时临时浮到最前，移开还原（临时状态，不写存档） */
  raise: () => ipcRenderer.send("wgt:raise"),
  rest: () => ipcRenderer.send("wgt:rest"),
  /* 系统光标是否还在窗口矩形内（主进程按 90ms 轮询，只在变化时推）。
     页面自己的 mouseleave 在窗口重排时会误报，收起这件事以这条为准。 */
  onCursor: (fn) => ipcRenderer.on("wgt:cursor", (_e, p) => fn(p || {})),
  /* 原生 caption 拖动开始 / 停下（主进程按 will-move / move 判），
     页面据此把卡片退成"只剩任务框"的样子，方便看对齐 */
  onDragLook: (fn) => ipcRenderer.on("wgt:drag-look", (_e, p) => fn(p || {})),
  /* 中键拖动：顶栏只有 22px 高，中键够不着原生拖动区，
     改成页面按屏幕坐标算位移，由主进程照着挪窗口 */
  dragBegin: () => ipcRenderer.send("wgt:drag-begin"),
  dragMove: (dx, dy) => ipcRenderer.send("wgt:drag-move", dx, dy),
  dragEnd: () => ipcRenderer.send("wgt:drag-end"),
  /* 走主进程查 IP 归属：绕开系统代理，避免定位到代理出口所在的国家 */
  geoIP: () => ipcRenderer.invoke("wgt:geo-ip"),
  /* 唤出另一张卡片（天气 ↔ 待办） */
  openCard: (kind) => ipcRenderer.invoke("wgt:open-card", kind),
  onRefresh: (fn) => ipcRenderer.on("wgt:refresh", () => fn()),
  onSearchOpen: (fn) => ipcRenderer.on("wgt:search-open", () => fn()),
  onRelocate: (fn) => ipcRenderer.on("wgt:relocate", () => fn()),
  /* 待办卡片用 */
  onFocusInput: (fn) => ipcRenderer.on("todo:focus-input", () => fn()),
  onClearDone: (fn) => ipcRenderer.on("todo:clear-done", () => fn()),
  onShowHistory: (fn) => ipcRenderer.on("todo:show-history", () => fn()),
  /* 按内容高度改窗口。传 {h, top, topMin}：
     h=卡片高度，top=待办区上沿距卡片顶的距离，topMin=收起时的 top。
     主进程靠 top 的变化反推窗口该往上挪多少，让条目在屏幕上不动。 */
  setCardHeight: (msg) => ipcRenderer.invoke("wgt:set-card-height", msg),
});
