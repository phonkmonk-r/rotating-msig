import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

// In the macOS desktop app the window has no title bar: leave room for the window controls and add a drag strip.
if ("signer" in window && navigator.userAgent.includes("Mac")) {
  document.documentElement.classList.add("desktop-mac");
  const strip = document.createElement("div");
  strip.className = "titlebar";
  document.body.prepend(strip);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
