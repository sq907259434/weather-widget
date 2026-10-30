const { contextBridge, ipcRenderer } = require("electron");

/* 输入桥专用 preload：隐形输入窗与主进程之间的最小通道。
   通信用完即藏（见 main.js 的 imeHide），不占常驻资源。 */
contextBridge.exposeInMainWorld("ime", {
  onInit: (fn) => ipcRenderer.on("ime:init", (_e, v) => fn(v)),
  text: (v) => ipcRenderer.send("ime:text", v),
  commit: () => ipcRenderer.send("ime:commit"),
  cancel: () => ipcRenderer.send("ime:cancel"),
  blur: () => ipcRenderer.send("ime:blur"),
});
