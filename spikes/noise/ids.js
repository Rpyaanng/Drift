// Spike (throwaway): are device ids the same in two of Drift's file:// windows (the main one and the voice window)?
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const R = path.join(__dirname, '..', '..', 'renderer');
const q = 'navigator.mediaDevices.enumerateDevices().then((d) => d.filter((x) => x.kind === "audioinput").map((x) => x.deviceId.slice(0, 10) + "/" + (x.label || "?")).join(" "))';
app.whenReady().then(async () => {
  const a = new BrowserWindow({ show: false, webPreferences: { sandbox: true } }), b = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await a.loadFile(path.join(R, 'voice.html')); await b.loadFile(path.join(R, 'sfx.js'));
  console.log('voice.html:', await a.webContents.executeJavaScript(q));
  console.log('other file:', await b.webContents.executeJavaScript(q));
  app.quit();
});
