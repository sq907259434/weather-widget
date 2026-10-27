const { contextBridge, ipcRenderer } = require("electron");

/* 是否使用系统磨砂：由主进程按 Windows 版本决定，通过启动参数传进来 */
const ACRYLIC = process.argv.some((a) => a === "--wgt-acrylic=1");

contextBridge.exposeInMainWorld("wgt", {
  acrylic: ACRYLIC,
  close: () => ipcRenderer.send("wgt:close"),
  menu: () => ipcRenderer.send("wgt:menu"),
  getTop: () => ipcRenderer.invoke("wgt:get-top"),
  setTop: (v) => ipcRenderer.invoke("wgt:set-top", v),
  /* 走主进程查 IP 归属：绕开系统代理，避免定位到代理出口所在的国家 */
  geoIP: () => ipcRenderer.invoke("wgt:geo-ip"),
  onRefresh: (fn) => ipcRenderer.on("wgt:refresh", () => fn()),
  onSearchOpen: (fn) => ipcRenderer.on("wgt:search-open", () => fn()),
  onRelocate: (fn) => ipcRenderer.on("wgt:relocate", () => fn()),
});
