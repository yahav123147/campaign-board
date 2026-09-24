import { psSingleQuoted, resolveWindowsPowerShell, WSL_POWERSHELL_PATH } from "./secretStore";

/** Only a web URL made of URL characters reaches the Windows browser. */
const WEB_URL = /^https?:\/\/[A-Za-z0-9._~%:/?#\[\]@!$&()*+,;=-]+$/;

/**
 * The exact launch that opens a URL in the Windows default browser from
 * WSL2, or undefined when the URL must not be handed to Windows at all
 * (a Linux file:// path, a non-web scheme, a quote or whitespace).
 *
 * The URL travels as a single-quoted PowerShell literal inside an
 * -EncodedCommand. A string -Command re-joins every later argv element into
 * the script text, so "$args" is empty there and quoting is lost; the
 * encoded form takes command-line parsing out of the picture and the
 * single-quoted literal interpolates nothing. Kept as a pure function so the
 * acceptance smoke on a real WSL2 runner spawns precisely what stage 5.4 does.
 */
export function windowsBrowserLaunch(url: string): { command: string; args: string[] } | undefined {
  if (!WEB_URL.test(url) || url.includes("'")) return undefined;
  const script = `Start-Process -FilePath ${psSingleQuoted(url)}`;
  return {
    command: resolveWindowsPowerShell() ?? WSL_POWERSHELL_PATH,
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
