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
  listSafes: call("safes:list"),
  selectSafe: call("safes:select"),
  removeSafe: call("safes:remove"),
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
  refill: call("signer:refill"),
  skipUsedKeys: call("signer:skipUsedKeys"),
  browserOpen: call("browser:open"),
  browserBounds: call("browser:bounds"),
  browserNavigate: call("browser:navigate"),
  browserState: call("browser:state"),
  browserClose: call("browser:close"),
  browserPending: call("browser:pending"),
  browserPreview: call("browser:preview"),
  browserApprove: call("browser:approve"),
  browserReject: call("browser:reject"),
  browserQueue: call("browser:queue"),
  draft: call("draft:get"),
  draftMode: call("draft:mode"),
  draftAdd: call("draft:add"),
  draftRemove: call("draft:remove"),
  draftMove: call("draft:move"),
  draftClear: call("draft:clear"),
  draftSimulate: call("draft:simulate"),
  draftPropose: call("draft:propose"),
  creatingState: call("create:state"),
  createPlan: call("create:plan"),
  createAccept: call("create:accept"),
  createAdd: call("create:add"),
  createLaunch: call("create:launch"),
  createCheck: call("create:check"),
  createCancel: call("create:cancel"),
  addingState: call("adding:state"),
  addingPrepare: call("adding:prepare"),
  addingCheck: call("adding:check"),
  addingCancel: call("adding:cancel"),
  onCreateStage: (listener) => subscribe("create:stage", listener),
  onBrowserState: (listener) => subscribe("browser:state", listener),
  onBrowserRequest: (listener) => subscribe("browser:request", listener),
});
