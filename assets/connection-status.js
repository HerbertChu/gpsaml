const { ipcRenderer } = require("electron");

const pulse = document.getElementById("pulse");
const bar = document.getElementById("bar");
const label = document.getElementById("label");
const headline = document.getElementById("headline");
const gatewayEl = document.getElementById("gateway");
const uptimeEl = document.getElementById("uptime");
const indicatorText = document.getElementById("indicatorText");
const button = document.getElementById("disconnect");

let startedAt = Date.now();
let timer = setInterval(updateUptime, 1000);
updateUptime();

let userInitiated = false;
let tunnelDown = false;
let reconnecting = false;
let countdownTimer = null;

function pad(n) {
  return String(n).padStart(2, "0");
}
function updateUptime() {
  const ms = Date.now() - startedAt;
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  uptimeEl.textContent = `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

ipcRenderer.on("status-init", (_e, gateway) => {
  gatewayEl.textContent = gateway || "—";
  startedAt = Date.now();
});

ipcRenderer.on("status-connected", (_e, payload) => {
  // Tunnel is up — fresh connect or successful reconnect.
  tunnelDown = false;
  reconnecting = false;
  clearCountdown();
  if (!timer) timer = setInterval(updateUptime, 1000);

  pulse.classList.remove("disconnecting", "disconnected", "reconnecting");
  bar.classList.remove("disconnected", "reconnecting");
  label.classList.remove("disconnecting", "disconnected", "reconnecting");

  const attempt = (payload && payload.attempt) || 0;
  if (attempt > 0) {
    label.textContent = `tunnel re-established (attempt ${attempt})`;
  } else {
    label.textContent = "tunnel established";
  }
  headline.textContent = "connected";
  indicatorText.textContent = "live";
  button.disabled = false;
  button.textContent = "disconnect";
});

ipcRenderer.on("status-reconnecting", (_e, payload) => {
  // Tunnel dropped; main is going to spawn openconnect again after a delay.
  reconnecting = true;
  tunnelDown = false;
  // Keep uptime running — cumulative session, not per-attempt.
  pulse.classList.remove("disconnecting", "disconnected");
  pulse.classList.add("reconnecting");
  bar.classList.remove("disconnected");
  bar.classList.add("reconnecting");
  label.classList.remove("disconnecting", "disconnected");
  label.classList.add("reconnecting");

  const attempt = (payload && payload.attempt) || 1;
  const delayMs = (payload && payload.delayMs) || 0;
  let remaining = Math.ceil(delayMs / 1000);
  const renderLabel = () => {
    label.textContent =
      remaining > 0
        ? `reconnecting in ${remaining}s (attempt ${attempt})`
        : `reconnecting… (attempt ${attempt})`;
  };
  renderLabel();
  headline.textContent = "reconnecting";
  indicatorText.textContent = "retry";

  clearCountdown();
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining < 0) {
      clearCountdown();
      label.textContent = `reconnecting… (attempt ${attempt})`;
      return;
    }
    renderLabel();
  }, 1000);

  button.disabled = false;
  button.textContent = "cancel";
});

ipcRenderer.on("force-disconnect", () => {
  // Tray menu requested disconnect — route through the button so the
  // UI updates the same way (userInitiated flag, "tearing down" label).
  if (!button.disabled) button.click();
});

ipcRenderer.on("status-disconnected", () => {
  tunnelDown = true;
  reconnecting = false;
  clearCountdown();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  pulse.classList.remove("disconnecting", "reconnecting");
  pulse.classList.add("disconnected");
  bar.classList.remove("reconnecting");
  bar.classList.add("disconnected");
  label.classList.remove("disconnecting", "reconnecting");
  label.classList.add("disconnected");
  headline.textContent = "disconnected";
  indicatorText.textContent = "down";
  if (userInitiated) {
    label.textContent = "tunnel terminated";
    button.disabled = true;
    button.textContent = "closing";
  } else {
    label.textContent = "session expired — please reconnect";
    button.disabled = false;
    button.textContent = "close";
  }
});

button.addEventListener("click", () => {
  if (button.disabled) return;
  userInitiated = true;
  button.disabled = true;
  if (tunnelDown) {
    button.textContent = "closing";
  } else if (reconnecting) {
    clearCountdown();
    button.textContent = "cancelling";
    label.textContent = "cancelling reconnect";
    indicatorText.textContent = "...";
  } else {
    button.textContent = "disconnecting";
    pulse.classList.add("disconnecting");
    label.classList.add("disconnecting");
    label.textContent = "tearing down tunnel";
    indicatorText.textContent = "...";
  }
  ipcRenderer.send("disconnect-requested");
});
