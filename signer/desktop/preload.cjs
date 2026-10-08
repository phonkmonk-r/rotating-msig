// Bridge between the sandboxed UI and the main process. Exposes only these calls; the UI never gets Node or Electron.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const subscribe = (channel, listener) => {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("signer", {
  state: call("app:state"),
  join: call("app:join"),
  onProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on("app:progress", handler);
    return () => ipcRenderer.removeListener("app:progress", handler);
  },
  addSeedProfile: call("profiles:addSeed"),
  addLedgerProfile: call("profiles:addLedger"),
  selectProfile: call("profiles:select"),
  deselectProfile: call("profiles:deselect"),
  renameProfile: call("profiles:rename"),
  removeProfile: call("profiles:remove"),
  connectLedger: call("ledger:connect"),
  unlock: call("vault:unlock"),
  lock: call("vault:lock"),
  reset: call("app:reset"),
  status: call("signer:status"),
  queue: call("signer:queue"),
  confirm: call("signer:confirm"),
  execute: call("signer:execute"),
  execution: call("signer:execution"),
  propose: call("signer:propose"),
  token: call("signer:token"),
  browserOpen: call("browser:open"),
  browserBounds: call("browser:bounds"),
  browserNavigate: call("browser:navigate"),
  browserState: call("browser:state"),
  browserClose: call("browser:close"),
  browserPending: call("browser:pending"),
  browserPreview: call("browser:preview"),
  browserApprove: call("browser:approve"),
  browserReject: call("browser:reject"),
  creatingState: call("create:state"),
  createPlan: call("create:plan"),
  createAccept: call("create:accept"),
  createAdd: call("create:add"),
  createLaunch: call("create:launch"),
  createCheck: call("create:check"),
  createCancel: call("create:cancel"),
  onCreateStage: (listener) => subscribe("create:stage", listener),
  onBrowserState: (listener) => subscribe("browser:state", listener),
  onBrowserRequest: (listener) => subscribe("browser:request", listener),
});
