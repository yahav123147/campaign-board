import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { trackChildProcess } from "./childProcessRegistry";

export type SecretBackend = "macos-keychain" | "windows-credential-manager" | "linux-secret-tool";

export interface SecretStoreDeps {
  readonly platform?: NodeJS.Platform;
  readonly wsl?: boolean;
  readonly spawn?: typeof nodeSpawn;
}

export const SECRET_TIMEOUT_MS = 10_000;
export const MAX_SECRET_BYTES = 16 * 1024;

/** WSL2 kernels announce themselves; the env var covers older builds. */
export function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

export function detectSecretBackend(platform: NodeJS.Platform = process.platform, wsl = isWsl()): SecretBackend | undefined {
  if (platform === "darwin") return "macos-keychain";
  if (platform === "linux") return wsl ? "windows-credential-manager" : "linux-secret-tool";
  return undefined;
}

export function installHint(backend: SecretBackend | undefined): string {
  switch (backend) {
    case "macos-keychain":
      return "צרו את הפריט ב-Keychain: /usr/bin/security add-generic-password -U -a \"$USER\" -s <service> -w";
    case "windows-credential-manager":
      return "שמרו את הסוד ב-Windows Credential Manager מתוך PowerShell של ווינדוס: cmdkey /generic:<service> /user:council /pass, ואז הריצו שוב בתוך WSL2";
    case "linux-secret-tool":
      return "התקינו secret-tool (sudo apt-get install libsecret-tools gnome-keyring), הפעילו keyring, ושמרו: secret-tool store --label=<service> service <service>";
    default:
      return "אין מחסן סודות נתמך במערכת הזו. השתמשו ב-macOS או ב-Ubuntu בתוך WSL2.";
  }
}

// Quotes a value as a single-quoted PowerShell string literal ('...' with
// embedded ' doubled to ''), for splicing directly into a rendered script.
// Rejects control characters (a newline would end the -Command line, a NUL
// would truncate it) rather than risk something that could break out of the
// quoting; never echoes the rejected value. Quotes themselves are handled by
// the doubling, so a name like it's is fine.
export function psSingleQuoted(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Secret service name is invalid (control character)");
  return `'${value.replaceAll("'", "''")}'`;
}

// Reads one generic credential's blob through the Win32 API and prints it.
// The service name and mode are spliced into the script as single-quoted
// PowerShell literals (via psSingleQuoted), not passed through $env: —
// WSLENV does not carry a per-process environment variable from a WSL2
// child into an interop-launched Windows process (measured on a real
// Windows+WSL2 CI runner: PowerShell saw the CI step's own Windows-side
// value instead of the child's COUNCIL_SECRET_MODE). Script transport via
// -Command is proven reliable at multi-KB size, so the literal is safe to
// splice directly.
//
// The struct is declared with [StructLayout] and read through
// Marshal.PtrToStructure rather than hand-computed Marshal.ReadInt32/
// ReadIntPtr offsets: CREDENTIALW's field offsets differ between 32-bit and
// 64-bit processes (LastWritten is an 8-byte FILETIME, and the pointer-sized
// fields that follow shift accordingly), and this script always runs under
// 64-bit powershell.exe. A hand-coded 32-bit offset silently read the wrong
// field as the blob size — a huge garbage value that either thrashed until
// the caller's timeout or threw immediately, never printing the value it
// mis-sized. Letting the marshaler own the layout is correct on either
// bitness and needs no memorized offsets to review.
//
// [Console]::OutputEncoding is set first because a redirected Windows
// PowerShell 5.1 writes through the OEM/ANSI code page while readSecret
// decodes utf-8. A token holding any non-ASCII character came back as
// mojibake, and a non-empty mojibake string fails open into stage 8 as an
// opaque Graph auth error rather than a secret-store error.
export function credReadScript(service: string, existsOnly: boolean): string {
  return `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace Council {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  public static class Cred {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
    const uint GENERIC = 1; const uint MAX_BLOB = 16 * 1024;
    // null = not found; throws on a blob larger than the product's cap.
    public static string Read(string target, bool existsOnly) {
      IntPtr ptr; if (!CredRead(target, GENERIC, 0, out ptr)) return null;
      try {
        var c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
        if (existsOnly) return "present";
        if (c.CredentialBlobSize > MAX_BLOB) throw new InvalidOperationException("credential blob exceeds the safety limit");
        var bytes = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
        // cmdkey stores the password as UTF-16LE, matching CharSet.Unicode above.
        return Encoding.Unicode.GetString(bytes);
      } finally { CredFree(ptr); }
    }
  }
}
'@
Add-Type -TypeDefinition $src
$r = [Council.Cred]::Read(${psSingleQuoted(service)}, ${existsOnly ? "$true" : "$false"})
if ($null -eq $r) { exit 2 }
[Console]::Out.Write($r)
`.trim();
}

function minimalEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    NODE_ENV: process.env.NODE_ENV,
    // WSL's binfmt interop launches powershell.exe through these two; isWsl()
    // itself reads them too, so a caller relying on WSL2 detection to pick
    // this backend must not have them stripped from the child's environment.
    WSL_INTEROP: process.env.WSL_INTEROP,
    WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
    ...extra,
  };
}

// Absolute, like the macOS backend's /usr/bin/security. Resolving these
// through the inherited PATH let anything earlier on it (a stale
// ~/.local/bin shim, a compromised dev tool) receive the service name and
// answer with a string of its own, which readSecret would then accept as the
// Meta token. A missing binary becomes ENOENT, which readSecret already turns
// into the backend's install hint.
export const SECRET_TOOL_PATH = "/usr/bin/secret-tool";
export const WSL_POWERSHELL_PATH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

export function secretCommand(backend: SecretBackend, service: string) {
  switch (backend) {
    case "macos-keychain":
      return { command: "/usr/bin/security", args: ["find-generic-password", "-s", service, "-w"], env: minimalEnv() };
    case "linux-secret-tool":
      return { command: SECRET_TOOL_PATH, args: ["lookup", "service", service], env: minimalEnv() };
    case "windows-credential-manager":
      return {
        command: WSL_POWERSHELL_PATH,
        args: ["-NoProfile", "-NonInteractive", "-Command", credReadScript(service, false)],
        env: minimalEnv(),
      };
  }
}

/**
 * A probe the doctor can run: proves the item exists without printing its
 * value. `discardStdout` tells the caller to spawn with stdout set to
 * "ignore" rather than merely leaving the captured output unused: Linux's
 * `secret-tool search` prints "secret = <value>" for a match (and exits 0
 * either way, which is useless as a presence signal), so the probe reuses
 * `lookup` instead — the exact read command, which exits 1 when the item is
 * missing — and relies on the caller never actually reading its stdout.
 * macOS's plain `find-generic-password` (no -g/-w) and Windows's exists-only
 * script (it returns "present" before ever touching the blob) never emit the
 * secret, so their stdout is safe to capture as usual.
 */
export function secretExistsCommand(backend: SecretBackend, service: string) {
  switch (backend) {
    case "macos-keychain":
      return { command: "/usr/bin/security", args: ["find-generic-password", "-s", service], env: minimalEnv(), discardStdout: false };
    case "linux-secret-tool":
      return { command: SECRET_TOOL_PATH, args: ["lookup", "service", service], env: minimalEnv(), discardStdout: true };
    case "windows-credential-manager":
      return {
        command: WSL_POWERSHELL_PATH,
        args: ["-NoProfile", "-NonInteractive", "-Command", credReadScript(service, true)],
        env: minimalEnv(),
        discardStdout: false,
      };
  }
}

/**
 * Read one secret from the host's own credential store. Fails closed: no
 * store, missing item, non-zero exit, empty or oversized output, timeout and
 * abort are all rejections that name the service and never the value.
 * The shape (timeout, size cap, abort, SIGTERM then SIGKILL) is the one the
 * Meta token reader had; it now serves every secret.
 */
export async function readSecret(service: string, signal?: AbortSignal, deps: SecretStoreDeps = {}): Promise<string> {
  signal?.throwIfAborted();
  const backend = detectSecretBackend(deps.platform, deps.wsl);
  if (!backend) throw new Error(`No secret store for service '${service}': ${installHint(undefined)}`);
  const spawn = deps.spawn ?? nodeSpawn;
  const { command, args, env } = secretCommand(backend, service);

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
    trackChildProcess(proc, "secret-read");
    let stdout = Buffer.alloc(0);
    let settled = false;
    let terminationError: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    // Settles the outer promise. Does not touch `forceKill`: on a real child
    // that timer must keep running (SIGTERM then, if the process ignores it,
    // SIGKILL after 2s) independent of whether the promise already settled.
    const settle = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    // Kills the child and rejects immediately, instead of waiting for the
    // eventual "close" — abort/timeout/size-limit are caller-facing failures
    // the moment we decide to terminate, not only once the OS confirms exit.
    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      proc.kill("SIGTERM");
      forceKill = setTimeout(() => proc.kill("SIGKILL"), 2_000);
      forceKill.unref();
      settle(error);
    };
    const onAbort = () => terminate(new Error(`Secret read for '${service}' was aborted`));
    const timeout = setTimeout(() => terminate(new Error(`Secret read for '${service}' timed out`)), SECRET_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_SECRET_BYTES) {
        terminate(new Error(`Secret for '${service}' exceeded the safety limit`));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    proc.stderr.resume();
    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (terminationError) return;
      settle(error.code === "ENOENT" ? new Error(`Secret store command for '${service}' is not installed: ${installHint(backend)}`) : error);
    });
    proc.on("close", (code) => {
      if (forceKill) clearTimeout(forceKill);
      if (settled) return;
      const value = stdout.toString("utf-8").trim();
      if (code !== 0 || !value) {
        settle(new Error(`Secret is unavailable in ${backend} for service '${service}'. ${installHint(backend)}`));
        return;
      }
      settle(undefined, value);
    });
  });
}
