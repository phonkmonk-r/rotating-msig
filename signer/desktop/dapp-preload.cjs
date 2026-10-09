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
    // Left extensible and writable on purpose: many dApps set legacy MetaMask fields on window.ethereum (Uniswap sets
    // `autoRefreshOnNetworkChange` at startup) and crash if that throws. Freezing protected nothing: the page owns its
    // own scripts, and every request is still reviewed in the app, out of the page's reach.
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true });

    const info = Object.freeze({
      uuid: crypto.randomUUID(),
      name: "Cicada (Safe)",
      rdns: "io.raac.cicada",
      // signer/desktop/assets/icon.svg
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMxNzUyNGEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDYxZjFkIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPHJhZGlhbEdyYWRpZW50IGlkPSJnbG93IiBjeD0iMC41IiBjeT0iMC40MiIgcj0iMC41NSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmZmZmZiIgc3RvcC1vcGFjaXR5PSIwLjE0Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2ZmZmZmZiIgc3RvcC1vcGFjaXR5PSIwIi8+CiAgICA8L3JhZGlhbEdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJib2R5IiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2Y2Y2Y2YiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNkOTk2MmUiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9IndpbmciIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZmZmZmZmIiBzdG9wLW9wYWNpdHk9IjAuOTQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZGZmM2VhIiBzdG9wLW9wYWNpdHk9IjAuNjYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHg9IjY0IiB5PSI2NCIgd2lkdGg9Ijg5NiIgaGVpZ2h0PSI4OTYiIHJ4PSIyMDAiIGZpbGw9InVybCgjYmcpIi8+CiAgPHJlY3QgeD0iNjQiIHk9IjY0IiB3aWR0aD0iODk2IiBoZWlnaHQ9Ijg5NiIgcng9IjIwMCIgZmlsbD0idXJsKCNnbG93KSIvPgogIDxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUxMiA1MjgpIHNjYWxlKDEuMDQpIHRyYW5zbGF0ZSgtNTEyIC01ODUpIj4KICAgIDxwYXRoIGQ9Ik00MjIgNDE2IEM0MDggNTYwIDQ1MCA3MjAgNTEyIDgxMiBDNTc0IDcyMCA2MTYgNTYwIDYwMiA0MTYgWiIgZmlsbD0idXJsKCNib2R5KSIvPgogICAgPHBhdGggZD0iTTQzOCA1MTIgUTUxMiA1NDAgNTg2IDUxMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDYyMDFlIiBzdHJva2Utb3BhY2l0eT0iMC40NSIgc3Ryb2tlLXdpZHRoPSIxNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgICA8cGF0aCBkPSJNNDUwIDU5MiBRNTEyIDYxNiA1NzQgNTkyIiBmaWxsPSJub25lIiBzdHJva2U9IiMwNjIwMWUiIHN0cm9rZS1vcGFjaXR5PSIwLjQ1IiBzdHJva2Utd2lkdGg9IjE2IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICAgIDxwYXRoIGQ9Ik00NjYgNjY4IFE1MTIgNjg4IDU1OCA2NjgiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzA2MjAxZSIgc3Ryb2tlLW9wYWNpdHk9IjAuNDUiIHN0cm9rZS13aWR0aD0iMTYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogICAgPGcgaWQ9IndpbmdMIj4KICAgICAgPHBhdGggZD0iTTQ5NCA0MzAgQzM3MiA0NjIgMzE4IDY0MCAzNTYgODIyIEMzNzAgODg2IDQxNCA5MTIgNDQ2IDg5OCBDNDg0IDgwNiA1MDYgNjQwIDUxNiA0NzIgWiIgZmlsbD0idXJsKCN3aW5nKSIvPgogICAgICA8cGF0aCBkPSJNNDcwIDQ2NiBDMzkyIDU2MCAzNjIgNzAwIDM3OCA4NTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzBiM2IzNiIgc3Ryb2tlLW9wYWNpdHk9IjAuMjYiIHN0cm9rZS13aWR0aD0iMTIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogICAgICA8cGF0aCBkPSJNNDcwIDQ2NiBDNDUyIDYyMCA0NDAgNzYwIDQyMCA4ODIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzBiM2IzNiIgc3Ryb2tlLW9wYWNpdHk9IjAuMjYiIHN0cm9rZS13aWR0aD0iMTIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogICAgPC9nPgogICAgPHVzZSBocmVmPSIjd2luZ0wiIHRyYW5zZm9ybT0ibWF0cml4KC0xIDAgMCAxIDEwMjQgMCkiLz4KICAgIDxlbGxpcHNlIGN4PSI1MTIiIGN5PSI0MDYiIHJ4PSIxMDgiIHJ5PSI3OCIgZmlsbD0idXJsKCNib2R5KSIvPgogICAgPGVsbGlwc2UgY3g9IjUxMiIgY3k9IjMxNCIgcng9Ijg2IiByeT0iNjIiIGZpbGw9InVybCgjYm9keSkiLz4KICAgIDxjaXJjbGUgY3g9IjQ0MCIgY3k9IjMxMCIgcj0iMjciIGZpbGw9IiMwNjIwMWUiLz4KICAgIDxjaXJjbGUgY3g9IjU4NCIgY3k9IjMxMCIgcj0iMjciIGZpbGw9IiMwNjIwMWUiLz4KICA8L2c+Cjwvc3ZnPgo=",
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
