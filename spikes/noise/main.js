// Spike (throwaway): does RNNoise in an AudioWorklet load in a sandboxed file:// window like Drift's voice window, and how
// much noise does it take out? Builds 4 s of a speech-like signal (a buzzy 140 Hz voice, on for 1 s, off for 1 s) mixed with
// steady noise and keyboard-like clicks, runs it through renderer/noise-worklet.js in an OfflineAudioContext, and prints
// the noise left in the quiet parts and the voice kept in the loud parts, before and after.
//   electron spikes/noise/main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true } });
  ipcMain.handle('wasm', () => fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'vendor', 'rnnoise.wasm')));
  ipcMain.on('out', (_e, r) => { console.log(JSON.stringify(r, null, 1)); app.quit(); });
  w.webContents.on('console-message', (_e, _l, m) => console.log('page:', m));
  w.loadFile(path.join(__dirname, 'page.html'));
  setTimeout(() => { console.log('timed out'); app.quit(); }, 20000);
});
