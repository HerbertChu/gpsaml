/**
 * Bastion-mode client.
 *
 * When GPSAML_BASTION_URL + GPSAML_BASTION_SECRET are set, gpsaml stops
 * spawning a local openconnect entirely. Instead it walks the SAML +
 * gateway-login flow as usual, then hands the freshly-issued
 * `authcookie` to a remote bastion at `${GPSAML_BASTION_URL}/api/connect`.
 * The bastion (gpsaml-proxy) runs openconnect on its own Linux host
 * inside a per-user network namespace and returns a one-shot SSH key
 * that the user can hand to sshuttle for transparent corp-net access.
 *
 * This module is *only* the client side. The bastion side lives in
 * https://github.com/HerbertChu/gpsaml-proxy.
 */

import { ChildProcess, spawn } from "child_process";
import { createHmac } from "crypto";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import got from "got";
import * as log from "loglevel";
import { LoginResponse } from "./openconnect";

const KEY_PATH = join(homedir(), ".ssh", "gpsaml_proxy_id");

interface BastionConfig {
  url: string;
  secret: string;
}

interface ConnectResponse {
  private_key: string;
  ssh_user: string;
  ssh_host: string;
  sshuttle_command: string;
}

/**
 * Read bastion config from environment. Returns null when either var is
 * missing — caller should then fall back to the local-openconnect path.
 */
function readBastionConfig(): BastionConfig | null {
  const url = process.env.GPSAML_BASTION_URL?.trim();
  const secret = process.env.GPSAML_BASTION_SECRET?.trim();
  if (!url || !secret) return null;
  return { url: url.replace(/\/+$/, ""), secret };
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Hand the gateway-login result to the bastion and spawn sshuttle from
 * the response.  Returns the sshuttle ChildProcess so the rest of the
 * Electron app (status window, disconnect button, reconnect loop) can
 * stay agnostic about whether it's looking at openconnect or sshuttle.
 */
async function connectViaBastion(
  loginResp: LoginResponse,
  fingerprint: string,
  hostname: string,
  config: BastionConfig,
): Promise<ChildProcess> {
  const cookieParams = new URLSearchParams(loginResp as Record<string, string>);

  const body = JSON.stringify({
    username: loginResp.user,
    authcookie: cookieParams.toString(),
    gateway: hostname,
    fingerprint,
  });
  const signature = sign(config.secret, body);

  log.info(`POST ${config.url}/api/connect (user=${loginResp.user})`);
  let res: ConnectResponse;
  try {
    res = await got
      .post(`${config.url}/api/connect`, {
        body,
        headers: {
          "Content-Type": "application/json",
          "X-GPSAML-Signature": signature,
        },
        timeout: { request: 60_000 },
        retry: { limit: 0 },
      })
      .json<ConnectResponse>();
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`bastion /api/connect failed: ${detail}`);
  }

  // Save the freshly-issued private key. ~/.ssh/ might not exist on a
  // brand-new account; create with the right perms.
  const keyDir = dirname(KEY_PATH);
  try {
    mkdirSync(keyDir, { mode: 0o700 });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  writeFileSync(KEY_PATH, res.private_key, { mode: 0o600 });
  chmodSync(KEY_PATH, 0o600);
  log.info(`wrote bastion-issued ssh key to ${KEY_PATH}`);

  // Spawn sshuttle. Hard-coded args mirror the Recommended sshuttle
  // command the bastion suggests in its response — we don't blindly
  // shell-exec the response string because it'd open us up to whatever
  // the bastion replies with.
  const args = [
    "-r",
    `${res.ssh_user}@${res.ssh_host}`,
    "-e",
    `ssh -i ${KEY_PATH} -o StrictHostKeyChecking=accept-new`,
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "--dns",
  ];
  log.info(`spawning sshuttle ${args.join(" ")}`);
  const sshuttle = spawn("sshuttle", args, { env: process.env });

  sshuttle.stdout.on("data", (d) => process.stdout.write(`[sshuttle] ${d}`));
  sshuttle.stderr.on("data", (d) => process.stderr.write(`[sshuttle] ${d}`));
  sshuttle.on("close", (code) => log.info(`sshuttle exited with code ${code}`));
  sshuttle.on("error", (err) => log.error("sshuttle spawn error:", err));

  return sshuttle;
}

/**
 * Best-effort POST /api/disconnect. Failures are logged but never
 * thrown; the local sshuttle is already being torn down independently
 * and we don't want a flaky bastion call to block the UI's quit path.
 */
async function disconnectFromBastion(
  config: BastionConfig,
  username: string,
): Promise<void> {
  const body = JSON.stringify({ username });
  const signature = sign(config.secret, body);
  try {
    await got.post(`${config.url}/api/disconnect`, {
      body,
      headers: {
        "Content-Type": "application/json",
        "X-GPSAML-Signature": signature,
      },
      timeout: { request: 10_000 },
      retry: { limit: 0 },
    });
    log.info("bastion /api/disconnect ok");
  } catch (e) {
    log.warn("bastion /api/disconnect failed (best-effort):", e);
  }
}

export { connectViaBastion, disconnectFromBastion, readBastionConfig };
export type { BastionConfig };
