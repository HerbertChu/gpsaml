import { execFileSync } from "child_process";
import * as log from "loglevel";

export interface OrphanProcess {
  pid: number;
  command: string;
}

/**
 * Scan for openconnect processes that aren't ours. A clean startup yields
 * zero matches; any hits usually mean the previous gpsaml was force-killed
 * (UI freeze, sudo prompt timeout, etc.) and its openconnect child was
 * reparented to launchd. Those orphans keep utun up and the default route
 * pointing at a dead tunnel, which surfaces as EADDRNOTAVAIL the next time
 * we try to reach the portal.
 */
export function findOrphanOpenconnects(): OrphanProcess[] {
  if (process.platform === "win32") return [];
  let out = "";
  try {
    out = execFileSync("/bin/ps", ["-axo", "pid,command"], {
      encoding: "utf8",
    });
  } catch (e) {
    log.warn(`ps failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
  const orphans: OrphanProcess[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === process.pid) continue;
    // Match the actual binary, not arbitrary mentions ("grep openconnect",
    // a Slack message containing the word, etc.).
    if (!/(^|\/)openconnect(\s|$)/.test(cmd)) continue;
    orphans.push({ pid, command: cmd });
  }
  return orphans;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SIGTERM each pid, give openconnect ~3s to tear down its utun and routes,
 * then SIGKILL anything still alive. Also pauses briefly afterwards so
 * macOS finishes propagating the route-table cleanup before the caller
 * tries any outbound connection.
 */
export async function terminateOrphans(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      log.info(`SIGTERM sent to orphan openconnect ${pid}`);
    } catch (e) {
      log.warn(`SIGTERM ${pid} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!pids.some(isAlive)) break;
  }
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      log.warn(`SIGKILL escalated for orphan openconnect ${pid}`);
    } catch (e) {
      log.warn(`SIGKILL ${pid} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Give the kernel a moment to drop routes/utun before we try outbound.
  await sleep(500);
}
