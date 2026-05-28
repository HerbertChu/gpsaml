import { BrowserWindow, ipcMain } from "electron";
import { loadResource } from "./resource";

interface StatusWindowHandle {
  win: BrowserWindow;
  /** Resolves when the user clicks Disconnect (NOT when window is closed/hidden). */
  awaitDisconnect: Promise<void>;
  /** Notify the renderer that the underlying process has exited. */
  notifyDisconnected: () => void;
  /** Notify the renderer that we are between attempts of an auto-reconnect. */
  notifyReconnecting: (attempt: number, delayMs: number) => void;
  /** Notify the renderer that the tunnel is up (initial connect or reconnect success). */
  notifyConnected: (attempt?: number) => void;
  /**
   * Trigger the same disconnect path the in-window button does — used by
   * the tray "Disconnect" menu item so it goes through the userInitiated
   * teardown (and aborts the reconnect loop) instead of just SIGTERMing
   * the child, which the loop would treat as an unexpected drop and
   * reconnect from.
   */
  requestDisconnect: () => void;
  /** Bring the (possibly hidden) window back to the foreground. */
  show: () => void;
  /** Tear down the window for real (used during quit). */
  close: () => void;
}

async function createConnectionStatusWindow(
  gatewayLabel: string,
): Promise<StatusWindowHandle> {
  const win = new BrowserWindow({
    width: 380,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "VPN Status",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(loadResource("connection-status.html"));
  win.webContents.send("status-init", gatewayLabel);

  // Closing the window button hides it instead of destroying it; the VPN
  // tunnel keeps running in the background, accessible via the tray menu.
  // Setting `reallyClosing` to true (via the close() method) lets app quit.
  let reallyClosing = false;
  win.on("close", (event) => {
    if (!reallyClosing) {
      event.preventDefault();
      win.hide();
    }
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  let resolved = false;
  const settle = () => {
    if (resolved) return;
    resolved = true;
    ipcMain.removeAllListeners("disconnect-requested");
    resolve();
  };

  ipcMain.on("disconnect-requested", settle);

  return {
    win,
    awaitDisconnect: promise,
    notifyDisconnected: () => {
      if (!win.isDestroyed()) {
        win.webContents.send("status-disconnected");
      }
    },
    notifyReconnecting: (attempt, delayMs) => {
      if (!win.isDestroyed()) {
        win.webContents.send("status-reconnecting", { attempt, delayMs });
      }
    },
    notifyConnected: (attempt) => {
      if (!win.isDestroyed()) {
        win.webContents.send("status-connected", { attempt: attempt ?? 0 });
      }
    },
    requestDisconnect: () => {
      // Have the renderer drive its own UI update (sets userInitiated,
      // flips the button to "disconnecting", etc.) then it sends back
      // disconnect-requested, which calls settle. settle() is also
      // invoked directly as a fallback in case the window is unresponsive.
      if (!win.isDestroyed()) {
        win.webContents.send("force-disconnect");
      }
      settle();
    },
    show: () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    close: () => {
      reallyClosing = true;
      if (!win.isDestroyed()) win.close();
    },
  };
}

export { createConnectionStatusWindow, StatusWindowHandle };
