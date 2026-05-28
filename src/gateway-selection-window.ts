import { ipcMain, BrowserWindow } from "electron";
import { loadResource } from "./resource";

async function createGatewaySelectionWindow(
  gateways: string[] | any[],
): Promise<string | null> {
  const win = new BrowserWindow({
    width: 460,
    height: 440,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setMenuBarVisibility(false);

  await win.loadFile(loadResource("gateway-selector.html"));

  // Send the gateways list to the renderer once page is loaded
  win.webContents.send("set-gateways", gateways);

  const { promise, resolve } = Promise.withResolvers<string | null>();
  let settled = false;

  const submitHandler = (_event: any, gateway: string) => {
    if (settled) return;
    settled = true;
    ipcMain.removeListener("gateway-submitted", submitHandler);
    win.close();
    resolve(gateway);
  };

  ipcMain.on("gateway-submitted", submitHandler);

  // User closed the window without selecting — treat as "no selection" so the
  // caller can decide whether to quit or keep the app alive.
  win.on("closed", () => {
    ipcMain.removeListener("gateway-submitted", submitHandler);
    if (!settled) {
      settled = true;
      resolve(null);
    }
  });

  return promise;
}

export { createGatewaySelectionWindow };
