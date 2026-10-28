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
  /* 按内容高度改窗口（主进程会夹到合理区间并处理贴底情况） */
  setCardHeight: (h) => ipcRenderer.invoke("wgt:set-card-height", h),
});
