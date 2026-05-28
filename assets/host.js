const { ipcRenderer } = require("electron");

const form = document.getElementById("hostForm");
const hostInput = document.getElementById("host");
const rememberInput = document.getElementById("remember");
const submitBtn = form.querySelector("button[type=submit]");
const errorBanner = document.getElementById("errorBanner");

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}

function showError(message) {
  errorBanner.hidden = false;
  errorBanner.textContent = message;
  hostInput.disabled = false;
  submitBtn.disabled = false;
  hostInput.focus();
  hostInput.select();
}

ipcRenderer.on("host-error", (_e, message) => {
  showError(message);
});

ipcRenderer.on("host-init", (_e, payload) => {
  if (!payload) return;
  if (typeof payload.host === "string") hostInput.value = payload.host;
  if (typeof payload.remember === "boolean")
    rememberInput.checked = payload.remember;
  if (hostInput.value) hostInput.select();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const host = hostInput.value.trim();
  if (!host) return;
  clearError();
  ipcRenderer.send("host-submitted", { host, remember: rememberInput.checked });
  hostInput.disabled = true;
  submitBtn.disabled = true;
});

hostInput.addEventListener("input", () => {
  if (!errorBanner.hidden) clearError();
});
