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
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
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
      name: "Rotation Signer (Safe)",
      rdns: "io.raac.rotation-signer",
      icon:
        "data:image/svg+xml;base64," +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f7a55"/><path d="M10 13a7 7 0 0 1 12-3l1.5-1.5V14h-5.5l2-2a4.5 4.5 0 0 0-7.4 2zM22 19a7 7 0 0 1-12 3l-1.5 1.5V18h5.5l-2 2a4.5 4.5 0 0 0 7.4-2z" fill="#fff"/></svg>',
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
