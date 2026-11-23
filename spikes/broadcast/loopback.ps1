# Spike A's helper (throwaway): Windows process loopback (Windows 10 2004+), the same kind of helper as push-to-talk.
# Captures the sound of one process tree (include) or of everything except one process tree (exclude), and writes
# raw 48 kHz stereo 16-bit PCM to stdout until killed. Messages go to stderr.
#   powershell -File loopback.ps1 -TargetPid 1234 -Mode include|exclude
param([int]$TargetPid, [string]$Mode = 'include')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;

public static class Loopback {
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

  class Handler : IActivateHandler, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public void ActivateCompleted(IActivateOp op) { Done.Set(); }
  }

  public static void Run(int pid, bool include) {
    var ap = new ActivationParams { ActivationType = 1, TargetProcessId = (uint)pid, Mode = include ? 0 : 1 };
    IntPtr apPtr = Marshal.AllocHGlobal(Marshal.SizeOf(ap)); Marshal.StructureToPtr(ap, apPtr, false);
    var pv = new PropVariant { vt = 65 /* VT_BLOB */, cbSize = (uint)Marshal.SizeOf(ap), pBlobData = apPtr };
    IntPtr pvPtr = Marshal.AllocHGlobal(Marshal.SizeOf(pv)); Marshal.StructureToPtr(pv, pvPtr, false);
    var h = new Handler(); IActivateOp op;
    ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, pvPtr, h, out op);
    if (!h.Done.WaitOne(5000)) throw new Exception("activation timed out");
    int hr; object o; op.GetActivateResult(out hr, out o);
    if (hr != 0) throw new Exception("activation failed 0x" + hr.ToString("x8"));
    var client = (IAudioClient)o;
    // Process loopback has no mix format of its own (GetMixFormat isn't implemented): ask for what we want
    var wf = new WaveFormat { tag = 1, channels = 2, rate = 48000, bits = 16, align = 4, bytesPerSec = 48000 * 4, cb = 0 };
    IntPtr wfPtr = Marshal.AllocHGlobal(Marshal.SizeOf(wf)); Marshal.StructureToPtr(wf, wfPtr, false);
    const uint LOOPBACK = 0x20000, EVENTCALLBACK = 0x40000, AUTOCONVERT = 0x80000000, SRC_DEFAULT_QUALITY = 0x08000000;
    hr = client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERT | SRC_DEFAULT_QUALITY, 200000, 0, wfPtr, IntPtr.Zero);
    if (hr != 0) throw new Exception("Initialize failed 0x" + hr.ToString("x8"));
    var ev = new AutoResetEvent(false);
    client.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
    object svc; hr = client.GetService(typeof(IAudioCaptureClient).GUID, out svc);
    if (hr != 0) throw new Exception("GetService failed 0x" + hr.ToString("x8"));
    var cap = (IAudioCaptureClient)svc;
    var stdout = Console.OpenStandardOutput(); var err = Console.Error;
    hr = client.Start(); if (hr != 0) throw new Exception("Start failed 0x" + hr.ToString("x8"));
    err.WriteLine("READY"); err.Flush();
    byte[] buf = new byte[48000 * 4];
    long packets = 0, frames = 0, silentFrames = 0; var t0 = DateTime.UtcNow;
    while (true) {
      ev.WaitOne(200);
      uint n;
      while (cap.GetNextPacketSize(out n) == 0 && n > 0) {
        IntPtr data; uint got, flags; ulong dp, qp;
        if (cap.GetBuffer(out data, out got, out flags, out dp, out qp) != 0) break;
        int bytes = (int)got * 4; if (bytes > buf.Length) buf = new byte[bytes];
        if ((flags & 2) != 0) { Array.Clear(buf, 0, bytes); silentFrames += got; } else Marshal.Copy(data, buf, 0, bytes);
        cap.ReleaseBuffer(got);
        stdout.Write(buf, 0, bytes); stdout.Flush();
        packets++; frames += got;
        if (packets % 200 == 0) { err.WriteLine("STAT packets=" + packets + " framesPerPacket=" + (frames / packets) + " silentFrames=" + silentFrames); err.Flush(); }
      }
    }
  }
}
'@
[Loopback]::Run($TargetPid, $Mode -eq 'include')
