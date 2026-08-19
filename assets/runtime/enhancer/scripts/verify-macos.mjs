#!/usr/bin/env node

import { LAUNCHER_BUNDLE_ID, createInstallPlan } from "../lib/install-config.mjs";
import { inspectOwnedInstallation, inspectSupportedApps } from "./install-macos.mjs";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseVerifyArgs(argv) {
  const options = {
    installed: false,
    requireStopped: false,
    skipLaunchctl: false,
    skipPlutil: false,
    launchctlPath: "/bin/launchctl",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--installed") options.installed = true;
    else if (argument === "--require-stopped") options.requireStopped = true;
    else if (argument === "--skip-launchctl") options.skipLaunchctl = true;
    else if (argument === "--skip-plutil") options.skipPlutil = true;
    else if (argument === "--launchctl-path") options.launchctlPath = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

async function loopbackPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.unref();
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export async function verifyMac(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const plan = createInstallPlan({ home, nodePath: options.nodePath, port: options.port });
  const [ownership, apps] = await Promise.all([
    inspectOwnedInstallation(plan),
    inspectSupportedApps(plan.supportedAppPaths),
  ]);
  const issues = [...ownership.issues];
  const warnings = [];
  if (!ownership.installed) issues.push("installation is absent");
  for (const [name, present] of Object.entries(ownership.targetExists)) {
    if (!present) issues.push(`required target is missing: ${name}`);
  }

  try {
    await access(plan.injectorPath, constants.R_OK);
  } catch {
    issues.push("injector is not readable");
  }
  try {
    await access(plan.launcherExecutablePath, constants.R_OK | constants.X_OK);
    const launcher = await readFile(plan.launcherExecutablePath, "utf8");
    if (launcher.includes("tell application") && launcher.includes(" to quit")) {
      issues.push("launcher contains an automatic application quit action");
    }
    if (!launcher.includes("/Applications/ChatGPT.app") || !launcher.includes("/Applications/Codex.app")) {
      issues.push("launcher does not support both ChatGPT.app and Codex.app");
    }
  } catch {
    issues.push("launcher executable is missing or not executable");
  }
  try {
    const infoPlist = await readFile(plan.launcherInfoPlistPath, "utf8");
    if (!infoPlist.includes(`<string>${LAUNCHER_BUNDLE_ID}</string>`)) issues.push("launcher bundle id mismatch");
  } catch {
    issues.push("launcher Info.plist is missing");
  }
  try {
    const plistMode = (await stat(plan.plistPath)).mode & 0o777;
    if (plistMode !== 0o644) issues.push(`LaunchAgent mode is ${plistMode.toString(8)}, expected 644`);
  } catch {
    issues.push("LaunchAgent plist is missing");
  }

  const runner = options.commandRunner ?? spawnSync;
  if (!options.skipPlutil && platform === "darwin" && ownership.targetExists.plistPath) {
    const result = runner("/usr/bin/plutil", ["-lint", plan.plistPath], { encoding: "utf8" });
    if (result?.status !== 0) issues.push(`plutil rejected LaunchAgent: ${String(result?.stderr || "unknown error").trim()}`);
  }
  let launchAgentLoaded = null;
  if (!options.skipLaunchctl && platform === "darwin") {
    const uid = options.uid ?? process.getuid?.();
    const result = runner(
      options.launchctlPath ?? "/bin/launchctl",
      ["print", `gui/${uid}/${plan.label}`],
      { encoding: "utf8" },
    );
    launchAgentLoaded = result?.status === 0;
    if (!launchAgentLoaded) issues.push("LaunchAgent is not loaded");
  }
  if (!apps.some((app) => app.installed)) warnings.push("Neither /Applications/ChatGPT.app nor /Applications/Codex.app is installed");
  let cdpStopped = null;
  if (options.requireStopped) {
    const isPortOpen = options.isPortOpen ?? loopbackPortOpen;
    cdpStopped = !(await isPortOpen(plan.port));
    if (!cdpStopped) issues.push(`Codex CDP endpoint is still listening on 127.0.0.1:${plan.port}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    launchAgentLoaded,
    supportedApps: apps,
    checked: {
      exactOwnedRoots: true,
      ownershipMarkersAndManifest: true,
      launcherSupportsBothApps: true,
      launcherDoesNotAutoRestartApp: true,
      applicationBundlesModified: false,
      plistLint: !options.skipPlutil && platform === "darwin",
      launchAgent: !options.skipLaunchctl && platform === "darwin",
      cdpStopped,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await verifyMac(parseVerifyArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
