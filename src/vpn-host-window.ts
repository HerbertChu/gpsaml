import { ipcMain, BrowserWindow } from "electron";
import { loadResource } from "./resource";

interface HostSubmission {
  host: string;
  remember: boolean;
}

interface HostWindowInit {
  /** Pre-fill the host input (typically the previously remembered address). */
  host?: string;
  /** Initial state of the "remember" checkbox. */
  remember?: boolean;
}

interface HostWindowHandle {
  /** Wait for the user to submit the form. May be called repeatedly. */
  awaitSubmit(): Promise<HostSubmission>;
  /** Display an inline error message and re-enable the input for retry. */
  showError(message: string): void;
  /** Close the window and detach the IPC listener. */
  close(): void;
}

async function createHostWindow(
  init: HostWindowInit = {},
): Promise<HostWindowHandle> {
  const win = new BrowserWindow({
    width: 460,
    height: 320,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(loadResource("host.html"));

  if (init.host || init.remember !== undefined) {
    win.webContents.send("host-init", {
      host: init.host ?? "",
      remember: init.remember ?? false,
    });
  }

  let pendingResolve: ((submission: HostSubmission) => void) | null = null;
  const submitListener = (_event: unknown, payload: unknown) => {
    const resolve = pendingResolve;
    pendingResolve = null;
    if (!resolve) return;
    if (payload && typeof payload === "object") {
      const p = payload as { host?: unknown; remember?: unknown };
      resolve({
        host: typeof p.host === "string" ? p.host : "",
        remember: p.remember === true,
      });
    } else if (typeof payload === "string") {
      // Backwards compat: older renderer sent just the host string.
      resolve({ host: payload, remember: false });
    } else {
      resolve({ host: "", remember: false });
    }
  };
  ipcMain.on("host-submitted", submitListener);

  return {
    awaitSubmit: () =>
      new Promise<HostSubmission>((resolve) => {
        pendingResolve = resolve;
      }),
    showError: (message: string) => {
      if (!win.isDestroyed()) {
        win.webContents.send("host-error", message);
      }
    },
    close: () => {
      ipcMain.removeListener("host-submitted", submitListener);
      if (!win.isDestroyed()) win.close();
    },
  };
}

export { createHostWindow, HostWindowHandle, HostSubmission };
