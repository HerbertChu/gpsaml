import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
} from "electron";
import { opts } from "./cli";
import isElevated from "is-elevated";
import sudo from "@expo/sudo-prompt";
import { Gateway, Portal } from "./endpoints";
import { connectVpn } from "./openconnect";
import {
  connectViaBastion,
  disconnectFromBastion,
  readBastionConfig,
} from "./bastion-client";
import * as log from "loglevel";
import { createHostWindow } from "./vpn-host-window";
import {
  clearRememberedHost,
  loadRememberedHost,
  saveRememberedHost,
} from "./config";
import { createGatewaySelectionWindow } from "./gateway-selection-window";
import {
  createConnectionStatusWindow,
  StatusWindowHandle,
} from "./connection-status-window";
import { loadResource } from "./resource";
import { installRotatingLog } from "./log-file";
import { findOrphanOpenconnects, terminateOrphans } from "./orphan-openconnect";
import { ChildProcess } from "child_process";
import { existsSync } from "fs";

// Disable GPU to avoid crashes in headless/server environments
app.disableHardwareAcceleration();

const VALID_LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "silent",
] as const;
type ValidLogLevel = (typeof VALID_LOG_LEVELS)[number];
const envLevel = process.env.GPSAML_LOG_LEVEL?.toLowerCase();
const initialLevel: ValidLogLevel =
  envLevel && (VALID_LOG_LEVELS as readonly string[]).includes(envLevel)
    ? (envLevel as ValidLogLevel)
    : "info";
log.setDefaultLevel(initialLevel);

let vpnProcess: ChildProcess | null = null;
let tray: Tray | null = null;
let statusWindow: StatusWindowHandle | null = null;
let trayAnimTimer: NodeJS.Timeout | null = null;
// Set by createTray(); call it whenever the connection state changes so
// the "Disconnect" item enables/disables correctly.
let refreshTrayMenu: () => void = () => {};

function setVpnProcess(p: ChildProcess | null): void {
  vpnProcess = p;
  refreshTrayMenu();
}

// 4-frame walking-dog silhouette for the menu-bar tray. Loaded as macOS
// template images so the OS recolors them for light/dark menu bars.
// Frames are pre-rendered to @2x PNGs at build time (assets/tray/) and
// cycle on a setInterval similar to apps like Runcat.
function loadDogFrames(): Electron.NativeImage[] {
  const out: Electron.NativeImage[] = [];
  for (let i = 0; i < 4; i++) {
    const file = loadResource(`tray/tray-dog-${i}@2x.png`);
    if (!existsSync(file)) return [];
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return [];
    img.setTemplateImage(true);
    out.push(img);
  }
  return out;
}

function startTrayAnimation(frames: Electron.NativeImage[]): void {
  if (!tray || frames.length === 0) return;
  let i = 0;
  tray.setImage(frames[0]);
  trayAnimTimer = setInterval(() => {
    if (!tray || tray.isDestroyed()) {
      stopTrayAnimation();
      return;
    }
    i = (i + 1) % frames.length;
    tray.setImage(frames[i]);
  }, 200);
}

function stopTrayAnimation(): void {
  if (trayAnimTimer) {
    clearInterval(trayAnimTimer);
    trayAnimTimer = null;
  }
}

function createTray(): void {
  // Try the animated walking-dog silhouette first (Runcat style). If SVG
  // rendering through nativeImage isn't supported on this Electron build
  // we fall back to a plain 🦮 emoji title (still cute, just static).
  const frames = loadDogFrames();
  if (frames.length > 0) {
    tray = new Tray(frames[0]);
    startTrayAnimation(frames);
  } else {
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("🦮");
  }
  tray.setToolTip("gpsaml");

  const showWindow = () => {
    // Prefer the connection-status window when it exists (it stays around for
    // the lifetime of the tunnel and may be hidden). Fall back to whichever
    // BrowserWindow is currently open (host or gateway selector).
    if (statusWindow) {
      statusWindow.show();
      return;
    }
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) return;
    const target = wins[wins.length - 1];
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  };

  const buildMenu = () => {
    const connected = vpnProcess !== null && vpnProcess.exitCode === null;
    return Menu.buildFromTemplate([
      { label: "gpsaml", enabled: false },
      { type: "separator" },
      { label: "Show window", click: showWindow },
      {
        label: "Disconnect",
        enabled: connected,
        click: () => {
          // Go through the status window so the reconnect loop's
          // AbortController gets aborted — just killing vpnProcess
          // makes the loop think the tunnel dropped unexpectedly and
          // it backs off + reconnects.
          if (statusWindow) {
            statusWindow.requestDisconnect();
          } else if (vpnProcess && vpnProcess.exitCode === null) {
            vpnProcess.kill();
          }
        },
      },
      { type: "separator" },
      {
        label: "Quit gpsaml",
        accelerator: "Cmd+Q",
        click: () => {
          if (vpnProcess && vpnProcess.exitCode === null) vpnProcess.kill();
          vpnProcess = null;
          app.quit();
        },
      },
    ]);
  };
  refreshTrayMenu = () => {
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
  };
  refreshTrayMenu();

  // Left-click the menu-bar icon: bring the window back. Right-click still
  // shows the context menu (Electron handles that automatically on macOS).
  tray.on("click", showWindow);
}

async function enterEntryPoint(): Promise<void> {
  // Retry the portal handshake (where DNS / prelogin / SAML errors live)
  // inline in the host window so a typo in the hostname becomes a red
  // banner instead of a silent close.
  const rememberedHost = loadRememberedHost();
  const hostWindow = await createHostWindow({
    host: rememberedHost,
    remember: !!rememberedHost,
  });
  let portal: Portal;
  while (true) {
    const { host: hostname, remember } = await hostWindow.awaitSubmit();
    try {
      portal = new Portal(hostname);
      await portal.doPrelogin();
      if (remember) saveRememberedHost(hostname);
      else clearRememberedHost();
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`prelogin failed: ${msg}`);
      hostWindow.showError(msg);
    }
  }

  try {
    await portal.doSamlAuth();
    const policy = await portal.getConfig();
    hostWindow.close();
    const fingerprint = portal.fingerprint;

    const bastion = readBastionConfig();
    if (bastion) {
      log.info(`bastion mode active (${bastion.url})`);
    }

    // Backoff schedule (ms) — capped at 60s, used after the n-th failure.
    const BACKOFF = [2000, 5000, 10000, 20000, 30000, 60000];

    // Outer loop: gateway selection → connect → disconnect → back to selection.
    // User exits via the tray "Quit gpsaml" menu, or by closing the gateway
    // selection window without picking anything.
    while (true) {
      const selGateway = await createGatewaySelectionWindow(policy.gateways);
      if (!selGateway) {
        // User dismissed the gateway selector — exit the app.
        app.quit();
        return;
      }
      const gateway = new Gateway(
        selGateway,
        policy.portalUserAuthCookie,
        policy.userName,
      );

      statusWindow = await createConnectionStatusWindow(gateway.hostname);

      const ac = new AbortController();
      statusWindow.awaitDisconnect.then(() => ac.abort());

      // Both helpers attach a one-shot listener to ac.signal. We must remove
      // it on the non-abort path too, otherwise listeners (each capturing
      // dead state) accumulate across every reconnect cycle.
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          if (ac.signal.aborted) return resolve();
          let t: NodeJS.Timeout;
          const onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          t = setTimeout(() => {
            ac.signal.removeEventListener("abort", onAbort);
            resolve();
          }, ms);
          ac.signal.addEventListener("abort", onAbort, { once: true });
        });

      const waitClose = (proc: ChildProcess) =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null) return resolve();
          const onAbort = () => {
            if (proc.exitCode === null) proc.kill();
          };
          proc.once("close", () => {
            ac.signal.removeEventListener("abort", onAbort);
            resolve();
          });
          ac.signal.addEventListener("abort", onAbort, { once: true });
        });

      // ── bastion mode: single-shot, sshuttle owns reconnects ─────────
      if (bastion) {
        let loginResp;
        let proc: ChildProcess;
        try {
          loginResp = await gateway.doLogin();
          proc = await connectViaBastion(
            loginResp,
            fingerprint!,
            gateway.hostname,
            bastion,
          );
          setVpnProcess(proc);
          statusWindow.notifyConnected();
        } catch (e) {
          log.error("bastion connect failed:", e);
          statusWindow.notifyDisconnected();
          await statusWindow.awaitDisconnect;
          statusWindow.close();
          statusWindow = null;
          app.quit();
          return;
        }

        await waitClose(proc);

        if (loginResp) {
          await disconnectFromBastion(bastion, loginResp.user);
        }
        setVpnProcess(null);
        statusWindow.close();
        statusWindow = null;
        app.quit();
        return;
      }

      let attempt = 0;
      let stoppedReason: "user" | "auth-failed" | null = null;
      while (!ac.signal.aborted) {
        let loginResp;
        try {
          loginResp = await gateway.doLogin();
        } catch (e) {
          log.error("gateway re-login failed:", e);
          stoppedReason = "auth-failed";
          break;
        }
        const proc = connectVpn(
          loginResp,
          loginResp.user,
          fingerprint!,
          gateway.hostname,
        );
        setVpnProcess(proc);
        if (attempt === 0) {
          statusWindow.notifyConnected();
        } else {
          statusWindow.notifyConnected(attempt);
        }

        await waitClose(proc);
        // Either openconnect exited on its own (about to reconnect) or
        // the user clicked Disconnect (will be cleared in the wrap-up
        // block below). Refresh menu either way.
        setVpnProcess(null);

        if (ac.signal.aborted) {
          stoppedReason = "user";
          break;
        }

        attempt += 1;
        const delay = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
        statusWindow.notifyReconnecting(attempt, delay);
        log.warn(
          `openconnect exited unexpectedly; reconnect attempt ${attempt} in ${delay}ms`,
        );
        await sleep(delay);
      }

      if (stoppedReason === "auth-failed") {
        // Cookie no longer valid — show the disconnected screen and wait for
        // the user to dismiss it before going back to gateway selection.
        setVpnProcess(null);
        statusWindow.notifyDisconnected();
        await statusWindow.awaitDisconnect;
      }
      setVpnProcess(null);
      statusWindow.close();
      statusWindow = null;
      // Loop back to gateway selection. User can pick again, or close the
      // selector window to quit.
    }
  } catch (e) {
    log.error("login flow failed:", e);
    // No modal dialog and no quit — the tray remains so the user can
    // see the failure in /tmp/gpsaml.log and quit on their own time.
    hostWindow.close();
  }
}

function shellEscape(s: string): string {
  // POSIX-safe single-quote escaping.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function relaunchAsRoot() {
  console.log("Root privileges required. Relaunching with sudo...");
  const args = process.argv
    .slice(1)
    .map((arg) => `"${arg.replace(/"/g, '\\"')}"`)
    .join(" ");

  let command = "";
  if (process.platform === "win32") {
    command = `cmd /c start "" "${process.execPath}" ${args}`;
  } else {
    // sudo-prompt detaches the elevated process from our stdio, so without
    // redirection any console.log / console.error after relaunch is lost.
    // Tee everything to a log file so users can attach it when reporting bugs.
    const cwd = process.cwd();
    const logPath = (process.env.GPSAML_LOG || "/tmp/gpsaml.log").replace(
      /"/g,
      '\\"',
    );

    // sudo-prompt invokes the elevated child via osascript with
    // administrator privileges, which strips the user's environment.
    // Forward the env vars our code actually reads so config like
    // bastion mode survives the privilege jump.
    const propagate = [
      "GPSAML_BASTION_URL",
      "GPSAML_BASTION_SECRET",
      "GPSAML_LOG",
      "GPSAML_LOG_LEVEL",
      "OPENCONNECT_PATH",
      "HIP_SCRIPT",
    ];
    const envPrefix = propagate
      .filter((k) => process.env[k])
      .map((k) => `${k}=${shellEscape(process.env[k]!)}`)
      .join(" ");
    const envBlock = envPrefix ? `${envPrefix} ` : "";
    command = `cd "${cwd.replace(/"/g, '\\"')}" && ${envBlock}"${process.execPath}" --disable-gpu --no-sandbox ${args} > "${logPath}" 2>&1 & disown`;
  }

  const options = {
    name: "GPSAML",
  };

  // We no longer log stdout/stderr.
  // Note: On POSIX this will still wait for the app to close.
  // On Windows 'start' allows it to return immediately.
  sudo.exec(command, options, (error) => {
    if (error) {
      console.error("Failed to acquire root privileges:", error);
    }
    app.quit();
  });
}

const bootstrap = async () => {
  const isAdmin = await isElevated();
  if (!isAdmin) {
    relaunchAsRoot();
    return;
  }

  // We're the elevated process — redirect Node's own stdout/stderr to a
  // size-capped log file so long sessions don't grow /tmp/gpsaml.log
  // without bound. The shell-level `> "${logPath}" 2>&1` in
  // relaunchAsRoot() still owns fd 1/2 for any pre-Node output (Electron
  // init, V8 warnings), but after this call all Node-side writes go
  // through the rotating fd instead.
  installRotatingLog(process.env.GPSAML_LOG || "/tmp/gpsaml.log");

  app.on("window-all-closed", () => {
    // just prevent the app terminated after the 1st window closed!
  });

  app.on("will-quit", () => {
    stopTrayAnimation();
    if (vpnProcess) {
      console.log("Terminating VPN process...");
      vpnProcess.kill();
      vpnProcess = null;
    }
  });

  process.on("SIGTERM", () => {
    if (vpnProcess) {
      console.log("Terminating VPN process on SIGTERM...");
      vpnProcess.kill();
      vpnProcess = null;
    }
    process.exit(0);
  });

  await app.whenReady();

  // Detect openconnect leftovers from a previous force-killed session.
  // Those hold the utun interface up and steal the default route, so the
  // next portal connect attempt fails with EADDRNOTAVAIL until they go
  // away. Ask the user before terminating in case they're using gpsaml
  // alongside another openconnect on purpose.
  const orphans = findOrphanOpenconnects();
  if (orphans.length > 0) {
    log.warn(`found ${orphans.length} orphan openconnect process(es)`);
    const list = orphans.map((o) => `${o.pid}: ${o.command}`).join("\n");
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "Leftover openconnect detected",
      message: "A previous openconnect process is still running.",
      detail:
        "It is keeping the VPN tunnel interface up and steering the " +
        "default route, which will cause the next portal connection to " +
        "fail (EADDRNOTAVAIL).\n\n" +
        list +
        "\n\nTerminate it before continuing?",
      buttons: ["Terminate and continue", "Continue anyway", "Quit gpsaml"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) {
      await terminateOrphans(orphans.map((o) => o.pid));
    } else if (choice === 2) {
      app.quit();
      return;
    }
  }

  // Install a minimal application menu so the system-standard editing
  // shortcuts (Cmd+C/V/X/A, Undo/Redo) work in our text inputs. Without
  // an explicit menu, Electron uses the default which enables the same
  // bindings — but BrowserWindow.setMenuBarVisibility(false) on each
  // window has been observed to suppress them on macOS, so we set the
  // template explicitly here.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "close" }],
      },
    ]),
  );

  createTray();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await enterEntryPoint();
    }
  });
  await enterEntryPoint();
};

bootstrap().catch((err) => {
  console.error("Failed to bootstrap application:", err);
  app.quit();
});
