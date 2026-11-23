// Opens EdgeBoard in your default browser when `npm run dev` starts it.

import { spawn } from "node:child_process";

/** The command that opens a web address on this kind of computer. */
export function openCommand(platform, url) {
  if (platform === "darwin") return ["open", [url]];
  // The empty "" is the window title `start` expects before the address.
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** Open the address, or say how to if this computer cannot. Never throws. */
export function openBrowser(url) {
  const [cmd, args] = openCommand(process.platform, url);
  const fallback = () => console.log(`Open ${url} in your browser.`);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", fallback);
    child.unref();
  } catch {
    fallback();
  }
}
