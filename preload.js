const { contextBridge, ipcRenderer } = require("electron");

/* 是否使用系统磨砂：由主进程按 Windows 版本决定，通过启动参数传进来 */
const ACRYLIC = process.argv.some((a) => a === "--wgt-acrylic=1");

contextBridge.exposeInMainWorld("wgt", {
  acrylic: ACRYLIC,
  close: () => ipcRenderer.send("wgt:close"),
  menu: () => ipcRenderer.send("wgt:menu"),
  /* 鼠标指上来时临时浮到最前，移开还原（临时状态，不写存档） */
  raise: () => ipcRenderer.send("wgt:raise"),
  rest: () => ipcRenderer.send("wgt:rest"),
  /* 拖动窗口：页面只报"按下/松开"，位移由主进程每 8ms 跟着系统光标直接搬窗口。
     卡片贴进桌面层后是 Progman 的子窗口，系统自带的 -webkit-app-region: drag
     在子窗口上不生效（会慢半拍甚至完全不动），所以整条拖动自己实现。 */
  dragBegin: () => ipcRenderer.send("wgt:drag-begin"),
  dragEnd: () => ipcRenderer.send("wgt:drag-end"),
  /* 缩放：Ctrl+滚轮，dir=+1 放大 / -1 缩小（5% 一档） */
  scaleStep: (dir) => ipcRenderer.send("wgt:scale-step", dir),
  /* 走主进程查 IP 归属：绕开系统代理，避免定位到代理出口所在的国家 */
  geoIP: () => ipcRenderer.invoke("wgt:geo-ip"),
  /* 搜索层开关：开着的这段时间，主进程替它盯着 ESC 和"点窗口外"。
     桌面层里窗口是 Progman 子窗口 —— 键盘焦点拿不到、点桌面也不会失焦，
     所以这两条系统级的"退出"信号只能在外面轮询补上。 */
  searchState: (on) => ipcRenderer.send("wgt:search-state", !!on),
  onSearchExit: (fn) => ipcRenderer.on("wgt:search-exit", () => fn()),
  onRefresh: (fn) => ipcRenderer.on("wgt:refresh", () => fn()),
  onSearchOpen: (fn) => ipcRenderer.on("wgt:search-open", () => fn()),
  onRelocate: (fn) => ipcRenderer.on("wgt:relocate", () => fn()),
  /* 桌面快照背景（与待办卡同款）：主进程裁好一块推过来 */
  backdropNow: () => ipcRenderer.invoke("wgt:backdrop-now"),
  onBackdrop: (fn) => ipcRenderer.on("wgt:backdrop", (_e, p) => fn(p || {})),
  /* 拖动实况：整幅快照 + 每 tick 窗口坐标（png 转 Uint8Array 才能过 contextBridge） */
  onBdFull: (fn) => ipcRenderer.on("wgt:bd-full", (_e, p) => fn(p && { ...p, png: new Uint8Array(p.png) })),
  onBdPos: (fn) => ipcRenderer.on("wgt:bd-pos", (_e, p) => fn(p || {})),
  onBdDragEnd: (fn) => ipcRenderer.on("wgt:bd-drag-end", () => fn()),
  /* 外观（透明度/磨砂）：面板开关走主进程菜单，值存 widget-state.json 的 look */
  getLook: () => ipcRenderer.invoke("wgt:get-look"),
  setLook: (v) => ipcRenderer.invoke("wgt:set-look", v),
  onShowLook: (fn) => ipcRenderer.on("wx:show-look", () => fn()),
  /* 桌面层输入桥：卡片是 Progman 子窗口拿不到键盘焦点，搜索框打字由
     主进程的隐形输入窗代收（见 main.js「桌面层输入桥」）。 */
  imeBegin: (rect) => ipcRenderer.send("wgt:ime-begin", rect),
  imeEnd: () => ipcRenderer.send("wgt:ime-end"),
  onImeText: (fn) => ipcRenderer.on("wx:ime-text", (_e, v) => fn(v)),
  onImeCommit: (fn) => ipcRenderer.on("wx:ime-commit", () => fn()),
  onImeCancel: (fn) => ipcRenderer.on("wx:ime-cancel", () => fn()),
  onImeBlur: (fn) => ipcRenderer.on("wx:ime-blur", () => fn()),
});
