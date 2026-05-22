const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 19090;
const CONFIG_URL = `http://localhost:${PORT}/`;

// Start the proxy server
require('./server.js');

function findElectronApp() {
  const electronPkg = path.join(__dirname, 'node_modules', 'electron');
  if (fs.existsSync(electronPkg)) {
    const appPath = path.join(electronPkg, 'dist', 'Electron.app');
    if (fs.existsSync(appPath)) return appPath;
  }
  return null;
}

const electronApp = findElectronApp();

if (electronApp && process.platform === 'darwin') {
  // macOS: launch Electron.app as a proper macOS app via 'open'
  // This triggers the default_app.asar which properly initializes the Electron environment
  console.log('[startup] Launching Electron config window...');
  exec(`open -a "${electronApp}" --args "${CONFIG_URL}"`, (err) => {
    if (err) console.log('[startup] Failed to launch Electron: ' + err.message);
  });
} else if (electronApp) {
  // Other platforms: try spawning the binary directly
  const binPath = path.join(electronApp, 'Contents', 'MacOS', 'Electron');
  const altBin = process.platform === 'win32'
    ? path.join(electronPkg, 'dist', 'electron.exe')
    : path.join(electronPkg, 'dist', 'electron');

  const bin = fs.existsSync(binPath) ? binPath : altBin;
  spawn(bin, [CONFIG_URL], { stdio: 'ignore', detached: true }).unref();
  console.log('[startup] Launched Electron config window.');
}

console.log(`[startup] Config UI: ${CONFIG_URL}`);
console.log('[startup] Proxy server running. Press Ctrl+C to stop.');
