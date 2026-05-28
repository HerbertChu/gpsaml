import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import * as log from "loglevel";

interface PersistedState {
  rememberedHost?: string;
}

function statePath(): string {
  return join(app.getPath("userData"), "state.json");
}

function readState(): PersistedState {
  const p = statePath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PersistedState;
  } catch (e) {
    log.warn(
      `failed to read state at ${p}: ${e instanceof Error ? e.message : e}`,
    );
  }
  return {};
}

function writeState(state: PersistedState): void {
  const p = statePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    log.warn(
      `failed to write state to ${p}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

export function loadRememberedHost(): string | undefined {
  return readState().rememberedHost;
}

export function saveRememberedHost(host: string): void {
  const state = readState();
  state.rememberedHost = host;
  writeState(state);
}

export function clearRememberedHost(): void {
  const state = readState();
  if (state.rememberedHost === undefined) return;
  delete state.rememberedHost;
  writeState(state);
}
