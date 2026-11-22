# Spike 2's helper: prints the default sound output's endpoint ids (console, multimedia, communications), or sets them.
#   default-output.ps1                       -> "id0|id1|id2"
#   default-output.ps1 -Set "id0|id1|id2"    (or one id for all three)
#   default-output.ps1 -Name "Realtek"       -> the id of the first active output whose name contains that
param([string]$Set = '', [string]$Name = '')
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  int GetMixFormat(); int GetDeviceFormat(); int ResetDeviceFormat(); int SetDeviceFormat(); int GetProcessingPeriod();
  int SetProcessingPeriod(); int GetShareMode(); int SetShareMode(); int GetPropertyValue(); int SetPropertyValue();
  int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(); int OpenPropertyStore(); int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IntPtr devs); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class Out {
  public static string Get(int role) { IMMDevice d; ((IMMDeviceEnumerator)new MMDeviceEnumerator()).GetDefaultAudioEndpoint(0, role, out d); string id; d.GetId(out id); return id; }
  public static void Set(string id, int role) { Marshal.ThrowExceptionForHR(((IPolicyConfig)new PolicyConfigClient()).SetDefaultEndpoint(id, role)); }
}
'@
if ($Name) {
  $d = Get-PnpDevice -Class AudioEndpoint -Status OK | Where-Object { $_.FriendlyName -like "*$Name*" -and $_.InstanceId -like 'SWD\MMDEVAPI\{0.0.0.*' } | Select-Object -First 1
  if ($d) { $d.InstanceId.Substring(13) }
} elseif ($Set) {
  $ids = $Set.Split('|'); for ($r = 0; $r -lt 3; $r++) { [Out]::Set($ids[[Math]::Min($r, $ids.Length - 1)], $r) }
} else { (0..2 | ForEach-Object { [Out]::Get($_) }) -join '|' }
