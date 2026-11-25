// Spike (throwaway): the real voice window (renderer/voice.html) with Chromium's fake microphone, as main.js would start
// it, with noise suppression strong, then switched to standard, then off, then back to strong; prints what it reports.
//   electron spikes/noise/voice-run.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const R = path.join(__dirname, '..', '..');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(R, 'voice-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  const states = [], speaking = [];
  ipcMain.on('voice', (_e, type, d) => {
    if (type === 'hello') w.webContents.send('voice', { t: 'start', me: 'meeeee', iceServers: [], policy: 'all', tone: false, talk: true, ptt: false, volumes: {}, master: 1, mic: { id: '', label: 'Fake Default Audio Input' }, out: { id: '', label: '' }, ns: 'strong' });
    else if (type === 'state') states.push(d.mic);
    else if (type === 'speaking') speaking.push(d.join() || '-');
    else if (type === 'log') console.log('voice log:', d);
  });
  w.loadFile(path.join(R, 'renderer', 'voice.html'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const test = () => w.webContents.executeJavaScript('window.voiceTest().then((r) => JSON.stringify(r))');
  await wait(2500);
  console.log('strong:', await test());
  const devs = await w.webContents.executeJavaScript('navigator.mediaDevices.enumerateDevices().then((d) => JSON.stringify(d.map((x) => x.kind + ":" + x.label + ":" + x.deviceId.slice(0, 8))))');
  console.log('devices:', devs);
  for (const ns of ['standard', 'off', 'strong']) {
    w.webContents.send('voice', { t: 'devices', mic: { id: '', label: '' }, out: { id: '', label: '' }, ns });
    await wait(1500);
    console.log(ns + ':', await test());
  }
  console.log('states:', states.join(' '), '| speaking:', speaking.join(' '));
  app.quit();
});
