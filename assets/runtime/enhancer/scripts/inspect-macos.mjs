#!/usr/bin/env node

import { createInstallPlan } from "../lib/install-config.mjs";
import { inspectOwnedInstallation, inspectSupportedApps } from "./install-macos.mjs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseInspectArgs(argv) {
  const options = { skipLaunchctl: false, launchctlPath: "/bin/launchctl" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-launchctl") options.skipLaunchctl = true;
    else if (argument === "--launchctl-path") options.launchctlPath = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export async function inspectMac(options = {}) {
  const home = options.home ?? os.homedir();
  const plan = createInstallPlan({ home, nodePath: options.nodePath, port: options.port });
  const [ownership, apps] = await Promise.all([
    inspectOwnedInstallation(plan),
    inspectSupportedApps(plan.supportedAppPaths),
  ]);
  let launchAgent = { checked: false, loaded: null, status: null };
  if (!options.skipLaunchctl && (options.platform ?? process.platform) === "darwin") {
    const uid = options.uid ?? process.getuid?.();
    const runner = options.commandRunner ?? spawnSync;
    const result = runner(
      options.launchctlPath ?? "/bin/launchctl",
      ["print", `gui/${uid}/${plan.label}`],
      { encoding: "utf8" },
    );
    launchAgent = { checked: true, loaded: result?.status === 0, status: result?.status ?? null };
  }
  return {
    platform: options.platform ?? process.platform,
    installed: ownership.installed,
    ownershipSafe: ownership.safeToModify,
    ownershipIssues: ownership.issues,
    targets: ownership.targetExists,
    supportedApps: apps,
    launchAgent,
    ownedRoots: {
      installDir: plan.installDir,
      stateDir: plan.stateDir,
      logsDir: plan.logsDir,
      plistPath: plan.plistPath,
      launcherPath: plan.launcherPath,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await inspectMac(parseInspectArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
