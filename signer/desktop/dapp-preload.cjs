// Preload for pages in the dApp browser. Gives the page an EIP-1193 wallet (window.ethereum, announced through
// EIP-6963) whose only capability is forwarding requests to the main process; the page gets nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__rotationSigner", {
  request: (method, params) => ipcRenderer.invoke("dapp:request", method, params),
});

contextBridge.executeInMainWorld({
  func: () => {
    const bridge = window.__rotationSigner;
    const listeners = {};
    const emit = (event, value) => {
      for (const listener of (listeners[event] || []).slice()) {
        try {
          listener(value);
        } catch (error) {
          console.error(error);
        }
      }
    };

    const request = async (args) => {
      if (!args || typeof args.method !== "string") throw Object.assign(new Error("Invalid request"), { code: -32600 });
      const reply = await bridge.request(args.method, args.params === undefined ? [] : args.params);
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
      return reply.result;
    };

    const provider = {
      isRotationSigner: true,
      request,
      on(event, listener) {
        (listeners[event] = listeners[event] || []).push(listener);
        return provider;
      },
      removeListener(event, listener) {
        listeners[event] = (listeners[event] || []).filter((candidate) => candidate !== listener);
        return provider;
      },
      enable: () => request({ method: "eth_requestAccounts" }),
      sendAsync(payload, callback) {
        request(payload).then(
          (result) => callback(null, { id: payload.id, jsonrpc: "2.0", result }),
          (error) => callback(error, { id: payload.id, jsonrpc: "2.0", error: { code: error.code, message: error.message } }),
        );
      },
    };
    provider.addListener = provider.on;
    provider.off = provider.removeListener;
    Object.freeze(provider);

    Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: false });

    const info = Object.freeze({
      uuid: crypto.randomUUID(),
      name: "Keyturn (Safe)",
      rdns: "io.raac.keyturn",
      icon:
        "data:image/svg+xml;base64," +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 64 896 896"><rect x="64" y="64" width="896" height="896" rx="200" fill="#0f7a55"/><path d="M611.2 239.5 A290 290 0 1 1 412.8 239.5" fill="none" stroke="#fff" stroke-width="64" stroke-linecap="round"/><path d="M478.6 215.6 L388.9 173.7 L436.7 305.3 Z" fill="#fff" stroke="#fff" stroke-width="18" stroke-linejoin="round"/><circle cx="512" cy="475" r="82" fill="#fff"/><path d="M468 520 L556 520 L540 660 Q538 676 522 676 L502 676 Q486 676 484 660 Z" fill="#fff"/></svg>',
        ),
    });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    window.dispatchEvent(new Event("ethereum#initialized"));

    request({ method: "eth_chainId" }).then(
      (chainId) => emit("connect", { chainId }),
      () => undefined,
    );
  },
});
