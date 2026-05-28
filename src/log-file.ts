import {
  closeSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const SIZE_CHECK_EVERY_BYTES = 256 * 1024;

let logFd: number | null = null;
let logPath: string | null = null;
let maxBytes = DEFAULT_MAX_BYTES;
let bytesSinceCheck = 0;
let rotating = false;

function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function tryClose(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
}

function rotate(): void {
  if (!logPath || logFd === null || rotating) return;
  rotating = true;
  try {
    const archive = `${logPath}.1`;
    tryUnlink(archive);
    try {
      renameSync(logPath, archive);
    } catch {
      /* current file might already be gone — fine */
    }
    tryClose(logFd);
    try {
      logFd = openSync(logPath, "a");
    } catch {
      logFd = null;
    }
  } finally {
    rotating = false;
    bytesSinceCheck = 0;
  }
}

function maybeRotate(): void {
  if (!logPath) return;
  try {
    const st = statSync(logPath);
    if (st.size >= maxBytes) rotate();
  } catch {
    /* ignore */
  }
}

function writeChunk(chunk: unknown): void {
  if (logFd === null) return;
  let buf: Buffer;
  if (typeof chunk === "string") buf = Buffer.from(chunk);
  else if (Buffer.isBuffer(chunk)) buf = chunk;
  else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk);
  else return;
  try {
    writeSync(logFd, buf);
  } catch {
    /* fd may have closed mid-rotation; drop this chunk */
  }
  bytesSinceCheck += buf.length;
  if (bytesSinceCheck >= SIZE_CHECK_EVERY_BYTES) {
    bytesSinceCheck = 0;
    maybeRotate();
  }
}

type StreamWriter = (
  chunk: unknown,
  encoding?: unknown,
  cb?: unknown,
) => boolean;

function installOverride(stream: NodeJS.WriteStream): void {
  const wrapped: StreamWriter = (chunk, encoding, cb) => {
    writeChunk(chunk);
    if (typeof encoding === "function") (encoding as () => void)();
    else if (typeof cb === "function") (cb as () => void)();
    return true;
  };
  (stream as unknown as { write: StreamWriter }).write = wrapped;
}

/**
 * Route process.stdout / process.stderr to an append-mode file with a hard
 * size cap. When the file exceeds `maxBytes`, it is renamed to `<path>.1`
 * (overwriting any previous archive) and a fresh file is opened.
 *
 * Called once at startup from the elevated main process. After install,
 * console.log / loglevel / child-process stdout callbacks all funnel
 * through the same rotating file, instead of growing unboundedly via the
 * shell-level stdout redirect set up by relaunchAsRoot().
 */
export function installRotatingLog(
  path: string,
  options: { maxBytes?: number } = {},
): void {
  logPath = path;
  if (options.maxBytes && options.maxBytes > 0) maxBytes = options.maxBytes;

  // Pre-rotate once if a prior session left a large file behind (relevant
  // mainly for dev runs without the shell-level `>` truncation).
  try {
    const st = statSync(path);
    if (st.size >= maxBytes) {
      const archive = `${path}.1`;
      tryUnlink(archive);
      try {
        renameSync(path, archive);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* file doesn't exist yet — openSync will create it */
  }

  try {
    logFd = openSync(path, "a");
  } catch {
    logFd = null;
    return;
  }

  installOverride(process.stdout);
  installOverride(process.stderr);
}
