import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";

let mainWindow: BrowserWindow | null = null;

interface CreateWindowOptions {
  isDev: boolean;
  dirname: string;
}

export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Bitterbot",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0a0a0f",
    show: false,
    webPreferences: {
      preload: path.join(opts.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // Beta: allow cross-origin iframes for canvas artifacts
    },
  });

  // Show window once the renderer is ready to avoid white flash
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    // Beta: enable DevTools via F12
    mainWindow?.webContents.on("before-input-event", (_event, input) => {
      if (input.key === "F12") {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setupWindowIPC(): void {
  ipcMain.on("window-minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.on("window-maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on("window-close", () => {
    mainWindow?.close();
  });
}
