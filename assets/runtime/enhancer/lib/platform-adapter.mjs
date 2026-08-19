import os from "node:os";
import path from "node:path";

export function assetBrowserRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (env.ASSET_BROWSER_ROOT) return path.resolve(env.ASSET_BROWSER_ROOT);
  if (platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "AssetBrowser");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "AssetBrowser");
  }
  return null;
}

export function resolvedTimeZone({ env = process.env } = {}) {
  const configured = String(env.CODEX_ENHANCER_TIME_ZONE || "").trim();
  if (configured) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isSupportedDesktopPlatform(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}
