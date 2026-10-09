// Renders desktop/assets/icon.svg into icon.png (1024 px, transparent outside the rounded square) and, on macOS,
// icon.icns. Run with Electron, which brings the SVG renderer: `npm run icons -w @rotating-msig/signer`.
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const assets = join(__dirname, "..", "desktop", "assets");
const SIZE = 1024;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const svg = readFileSync(join(assets, "icon.svg"), "utf8");
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${SIZE}" height="${SIZE}"></body></html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = (await window.webContents.capturePage()).resize({ width: SIZE, height: SIZE });
  writeFileSync(join(assets, "icon.png"), image.toPNG());

  if (process.platform === "darwin") {
    const iconset = join(mkdtempSync(join(tmpdir(), "cicada-icon-")), "icon.iconset");
    require("node:fs").mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
        execFileSync("sips", ["-z", String(size * scale), String(size * scale), join(assets, "icon.png"), "--out", join(iconset, name)], { stdio: "ignore" });
      }
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")]);
    rmSync(join(iconset, ".."), { recursive: true, force: true });
  }
  app.quit();
});
