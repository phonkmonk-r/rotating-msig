// Starts the desktop app. On macOS the name in the menu bar, the Dock and the app switcher comes from the app bundle,
// so the app runs from a copy of Electron's bundle renamed to Cicada with its icon (in `.app/`, rebuilt when Electron
// or the icon changes) instead of from Electron.app itself. Packaging will replace this.
const { execFileSync, spawn } = require("node:child_process");
const { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const signer = join(__dirname, "..");
const electron = require("electron");

function bundle() {
  const source = join(dirname(electron), "..", "..");
  const target = join(signer, ".app", "Cicada.app");
  const icon = join(signer, "desktop", "assets", "icon.icns");
  const stamp = `${require("electron/package.json").version} ${statSync(icon).mtimeMs}`;
  const stampFile = join(signer, ".app", "stamp");
  if (!existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    rmSync(join(signer, ".app"), { recursive: true, force: true });
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    const plist = join(target, "Contents", "Info.plist");
    for (const [key, value] of [
      ["CFBundleName", "Cicada"],
      ["CFBundleDisplayName", "Cicada"],
      ["CFBundleIdentifier", "io.raac.cicada"],
    ]) {
      execFileSync("plutil", ["-replace", key, "-string", value, plist]);
    }
    cpSync(icon, join(target, "Contents", "Resources", "electron.icns"));
    writeFileSync(stampFile, stamp);
  }
  return join(target, "Contents", "MacOS", "Electron");
}

const binary = process.platform === "darwin" ? bundle() : electron;
const child = spawn(binary, [signer, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
