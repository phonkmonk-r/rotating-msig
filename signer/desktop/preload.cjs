// Bridge between the sandboxed UI and the main process. Exposes only these calls; the UI never gets Node or Electron.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("signer", {
  state: call("app:state"),
  pickTree: call("app:pickTree"),
  createVault: call("vault:create"),
  unlock: call("vault:unlock"),
  lock: call("vault:lock"),
  configure: call("app:configure"),
  reset: call("app:reset"),
  status: call("signer:status"),
  queue: call("signer:queue"),
  confirm: call("signer:confirm"),
  execute: call("signer:execute"),
  execution: call("signer:execution"),
});
