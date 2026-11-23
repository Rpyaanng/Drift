// For loopback-test.js: an Electron app playing 1,500 Hz from a hidden window (so through Chromium's audio service)
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  w.loadURL('data:text/html,<script>const c=new AudioContext(),o=c.createOscillator(),g=c.createGain();o.frequency.value=1500;g.gain.value=0.1;o.connect(g).connect(c.destination);o.start()</script>');
});
