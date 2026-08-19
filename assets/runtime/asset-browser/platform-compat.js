import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultAssetBrowserRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir()
} = {}) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "AssetBrowser");
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "AssetBrowser");
  }
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "AssetBrowser");
}

export function resolveAssetBrowserRoot(options = {}) {
  const env = options.env || process.env;
  return path.resolve(env.ASSET_BROWSER_ROOT || defaultAssetBrowserRoot({ ...options, env }));
}

export function pathKey(filePath, { platform = process.platform } = {}) {
  const normalized = path.resolve(String(filePath || "")).normalize("NFC");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsEqual(left, right, options = {}) {
  return pathKey(left, options) === pathKey(right, options);
}

export function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function assertRealPathContained(root, target, { allowMissing = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isPathInside(absoluteRoot, absoluteTarget)) throw new Error("Path escapes the approved root");
  const rootReal = await fs.realpath(absoluteRoot);
  let probe = absoluteTarget;
  while (true) {
    try {
      const probeReal = await fs.realpath(probe);
      if (!isPathInside(rootReal, probeReal)) throw new Error("Path resolves outside the approved root");
      return absoluteTarget;
    } catch (error) {
      if (error?.code !== "ENOENT" || !allowMissing) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error("No existing parent inside the approved root");
      probe = parent;
    }
  }
}

export function pythonCandidates({ platform = process.platform, env = process.env } = {}) {
  const candidates = [];
  const configured = String(env.PYTHON || "").trim();
  if (configured) candidates.push({ command: configured, prefixArgs: [] });
  candidates.push({ command: "python3", prefixArgs: [] });
  if (platform === "win32") candidates.push({ command: "py", prefixArgs: ["-3"] });
  candidates.push({ command: "python", prefixArgs: [] });
  return candidates.filter((candidate, index, all) => all.findIndex((item) => (
    item.command === candidate.command && item.prefixArgs.join("\0") === candidate.prefixArgs.join("\0")
  )) === index);
}

function runCandidate(candidate, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, [...candidate.prefixArgs, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const onData = (stream) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxBuffer) {
        child.kill();
        finish(() => reject(new Error("Python 输出超过安全上限")));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(options.timeoutMessage || "Python 任务超时")));
    }, options.timeout);
    child.stdout.on("data", onData("stdout"));
    child.stderr.on("data", onData("stderr"));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => finish(() => resolve({
      code: Number.isInteger(code) ? code : 1,
      signal,
      stdout,
      stderr,
      command: candidate.command,
      args: [...candidate.prefixArgs, ...args]
    })));
  });
}

export async function runPythonCommand(args, {
  cwd,
  env = process.env,
  timeout = 120000,
  timeoutMessage = "Python 任务超时",
  maxBuffer = 4 * 1024 * 1024,
  platform = process.platform,
  pythonPath = ""
} = {}) {
  const candidates = pythonPath
    ? [{ command: String(pythonPath), prefixArgs: [] }]
    : pythonCandidates({ platform, env });
  let missingError = null;
  for (const candidate of candidates) {
    try {
      return await runCandidate(candidate, args, { cwd, env, timeout, timeoutMessage, maxBuffer });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missingError = error;
    }
  }
  const error = new Error("没有找到可用的 Python 3 解释器（已尝试 PYTHON、python3、py -3、python）");
  error.cause = missingError;
  throw error;
}
