// Throwaway: run main.js's window-follow helper (followScript) against a window, the way bcFollow does, and print what it says.
//   node follow-probe.js <hwnd> [main.js path]
const { spawn } = require('child_process');
const fs = require('fs');
const src = fs.readFileSync(process.argv[3] || require('path').join(__dirname, '..', '..', 'main.js'), 'utf8');
const body = src.slice(src.indexOf('const followScript = '), src.indexOf("].join('\\n');", src.indexOf('const followScript = ')) + 14);
const followScript = eval(body.replace('const followScript = ', ''));
const script = followScript(process.argv[2]);
const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
p.stdout.on('data', (d) => process.stdout.write('OUT ' + d));
p.stderr.on('data', (d) => process.stdout.write('ERR ' + d));
p.on('close', (c) => console.log('exit', c));
setTimeout(() => { p.kill(); }, 6000);
