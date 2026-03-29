import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bitterbot", {
  platform: process.platform,

  getGatewayUrl: async (): Promise<string> => {
    return ipcRenderer.invoke("get-gateway-url");
  },

  getVersion: async (): Promise<string> => {
    return ipcRenderer.invoke("get-version");
  },

  windowMinimize: () => {
    ipcRenderer.send("window-minimize");
  },

  windowMaximize: () => {
    ipcRenderer.send("window-maximize");
  },

  windowClose: () => {
    ipcRenderer.send("window-close");
  },

  openExternal: (url: string) => {
    ipcRenderer.invoke("open-external", url);
  },
});
