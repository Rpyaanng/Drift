// Drift — a broadcast's sound (docs/plans/broadcast.md §8, spike A). Electron can only capture the whole PC's sound,
// which includes the voice room, so viewers would hear themselves a moment late. Windows' process loopback (Windows 10
// build 20348 and later, and Windows 11) can do better, and a small helper of the same kind as push-to-talk (C#
// compiled by PowerShell's Add-Type, so there's no native module to ship) reaches it:
//   - an application window: only the sound of the process that owns the window, and its child processes;
//   - a whole screen: everything the PC plays except Drift's own process tree (voice, music, videos), so nobody hears
//     the voice room twice.
// It writes raw 48 kHz stereo 16-bit PCM to stdout, and stops by itself when its stdin closes (Drift quit or died).
// Nothing is recorded: the sound only goes to the broadcast window, which sends it to the people watching.
const { spawn } = require('child_process');

const RATE = 48000, CHANNELS = 2, BYTES = 4;       // per frame: two 16-bit samples

const SOURCE = String.raw`
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;

public static class DriftLoopback {
  [StructLayout(LayoutKind.Sequential)] struct ActivationParams { public int ActivationType; public uint TargetProcessId; public int Mode; }
  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; public ushort r1, r2, r3; public uint cbSize; public IntPtr pBlobData; }
  [StructLayout(LayoutKind.Sequential, Pack = 2)] struct WaveFormat { public ushort tag, channels; public uint rate, bytesPerSec; public ushort align, bits, cb; }

  [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateOp { void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
  [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IActivateHandler { void ActivateCompleted(IActivateOp op); }
  [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAgileObject { }
  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long def, out long min);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object svc);
  }
  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpcPos);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }
  [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
  static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, [MarshalAs(UnmanagedType.LPStruct)] Guid iid, IntPtr prop, IActivateHandler handler, out IActivateOp op);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

  class Handler : IActivateHandler, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public void ActivateCompleted(IActivateOp op) { Done.Set(); }
  }
  static void Fail(string why) { Console.Error.WriteLine("E|" + why); Console.Error.Flush(); Environment.Exit(1); }

  public static void Run(long hwnd, int pid, bool include) {
    // Drift closing our stdin (or dying) ends this at once
    var watch = new Thread(() => { try { var i = Console.OpenStandardInput(); var b = new byte[16]; while (i.Read(b, 0, b.Length) > 0) { } } catch { } Environment.Exit(0); });
    watch.IsBackground = true; watch.Start();
    if (hwnd != 0) { uint p; GetWindowThreadProcessId(new IntPtr(hwnd), out p); if (p == 0) Fail("window"); pid = (int)p; }
    if (pid <= 0) Fail("process");
    var ap = new ActivationParams { ActivationType = 1, TargetProcessId = (uint)pid, Mode = include ? 0 : 1 };
    IntPtr apPtr = Marshal.AllocHGlobal(Marshal.SizeOf(ap)); Marshal.StructureToPtr(ap, apPtr, false);
    var pv = new PropVariant { vt = 65 /* VT_BLOB */, cbSize = (uint)Marshal.SizeOf(ap), pBlobData = apPtr };
    IntPtr pvPtr = Marshal.AllocHGlobal(Marshal.SizeOf(pv)); Marshal.StructureToPtr(pv, pvPtr, false);
    var h = new Handler(); IActivateOp op;
    try { ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, pvPtr, h, out op); } catch (Exception e) { Fail("unsupported " + e.Message); return; }
    if (!h.Done.WaitOne(5000)) Fail("activation timed out");
    int hr; object o; op.GetActivateResult(out hr, out o);
    if (hr != 0) Fail("unsupported activation 0x" + hr.ToString("x8"));
    var client = (IAudioClient)o;
    // Process loopback has no mix format of its own: ask for what the broadcast window wants
    var wf = new WaveFormat { tag = 1, channels = 2, rate = 48000, bits = 16, align = 4, bytesPerSec = 48000 * 4, cb = 0 };
    IntPtr wfPtr = Marshal.AllocHGlobal(Marshal.SizeOf(wf)); Marshal.StructureToPtr(wf, wfPtr, false);
    const uint LOOPBACK = 0x20000, EVENTCALLBACK = 0x40000, AUTOCONVERT = 0x80000000, SRC_DEFAULT_QUALITY = 0x08000000;
    hr = client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERT | SRC_DEFAULT_QUALITY, 200000, 0, wfPtr, IntPtr.Zero);
    if (hr != 0) Fail("Initialize 0x" + hr.ToString("x8"));
    var ev = new AutoResetEvent(false);
    client.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
    object svc; hr = client.GetService(typeof(IAudioCaptureClient).GUID, out svc);
    if (hr != 0) Fail("GetService 0x" + hr.ToString("x8"));
    var cap = (IAudioCaptureClient)svc;
    var stdout = Console.OpenStandardOutput();
    hr = client.Start(); if (hr != 0) Fail("Start 0x" + hr.ToString("x8"));
    Console.Error.WriteLine("READY " + pid); Console.Error.Flush();
    byte[] buf = new byte[48000 * 4];
    while (true) {
      ev.WaitOne(200);
      uint n;
      while (cap.GetNextPacketSize(out n) == 0 && n > 0) {
        IntPtr data; uint got, flags; ulong dp, qp;
        if (cap.GetBuffer(out data, out got, out flags, out dp, out qp) != 0) break;
        int bytes = (int)got * 4; if (bytes > buf.Length) buf = new byte[bytes];
        if ((flags & 2) != 0) Array.Clear(buf, 0, bytes); else Marshal.Copy(data, buf, 0, bytes);       // AUDCLNT_BUFFERFLAGS_SILENT
        cap.ReleaseBuffer(got);
        try { stdout.Write(buf, 0, bytes); stdout.Flush(); } catch { Environment.Exit(0); }
      }
    }
  }
}
`;

const script = ({ hwnd = 0, pid = 0, include }) => [
  '$ErrorActionPreference = "Stop"',
  "try { Add-Type -TypeDefinition @'", SOURCE, "'@ } catch { [Console]::Error.WriteLine('E|type ' + $_.Exception.Message); exit 1 }",
  `[DriftLoopback]::Run([long]${Number(hwnd) || 0}, ${Number(pid) || 0}, $${include ? 'true' : 'false'})`,
].join('\n');

// Start capturing. what = { hwnd } (include that window's process tree) or { pid, exclude: true } (everything but that
// process tree). onPcm gets Buffers of whole frames; onEnd(error or '') once, when it stops for any reason but stop().
function start(what, { onPcm, onReady, onEnd }) {
  const include = !what.exclude;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script({ hwnd: what.hwnd, pid: what.pid, include }), 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '', ended = false, stopped = false, carry = Buffer.alloc(0), ready = false;
  const end = (why) => { if (ended) return; ended = true; if (!stopped && onEnd) onEnd(why); };
  p.stdout.on('data', (d) => {
    if (stopped) return;
    const all = carry.length ? Buffer.concat([carry, d]) : d, whole = all.length - (all.length % BYTES);
    carry = all.subarray(whole);
    if (whole) onPcm(all.subarray(0, whole));
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => {
    err = (err + d).slice(-2000);
    if (!ready && /READY/.test(err)) { ready = true; if (onReady) onReady(); }
  });
  p.stdin.on('error', () => {});
  p.on('error', (e) => end('helper ' + e.message));
  p.on('close', (code) => { const m = /E\|([^\r\n]*)/.exec(err); end(m ? m[1] : code ? `exit ${code}` : 'stopped'); });
  return {
    pid: p.pid,
    get ready() { return ready; },
    stop() { if (stopped) return; stopped = true; try { p.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 500); },
  };
}

module.exports = { start, RATE, CHANNELS, BYTES };
