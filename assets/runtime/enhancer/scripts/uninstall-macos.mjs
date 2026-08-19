#!/usr/bin/env node

import { assertExactOwnedRoots, createInstallPlan } from "../lib/install-config.mjs";
import { inspectOwnedInstallation } from "./install-macos.mjs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseUninstallArgs(argv) {
  const options = {
    dryRun: false,
    uninstall: false,
    skipLaunchctl: false,
    launchctlPath: "/bin/launchctl",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--uninstall") options.uninstall = true;
    else if (argument === "--skip-launchctl") options.skipLaunchctl = true;
    else if (argument === "--launchctl-path") options.launchctlPath = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.dryRun === options.uninstall) {
    throw new Error("Choose exactly one of --dry-run or --uninstall");
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function runBootout(plan, options) {
  if (options.skipLaunchctl) return { skipped: true, status: 0 };
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) throw new Error("A numeric user id is required for launchctl");
  const runner = options.commandRunner ?? spawnSync;
  const result = runner(
    options.launchctlPath ?? "/bin/launchctl",
    ["bootout", `gui/${uid}/${plan.label}`],
    { encoding: "utf8" },
  );
  const detail = String(result?.stderr || result?.error?.message || "").trim();
  const alreadyAbsent = /could not find service|no such process|service not found/i.test(detail);
  if (result?.status !== 0 && !alreadyAbsent) {
    throw new Error(`launchctl bootout failed; owned files were not removed: ${detail || `exit ${result?.status ?? "unknown"}`}`);
  }
  return result;
}

function assertCurrentHome(home, allowAlternateHome) {
  if (path.resolve(home) !== path.resolve(os.homedir()) && !allowAlternateHome) {
    throw new Error("Refusing to uninstall outside the current user's home directory");
  }
}

export async function uninstallMac(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error(`macOS uninstaller cannot run on ${platform}`);
  const home = options.home ?? os.homedir();
  assertCurrentHome(home, options.allowAlternateHome);
  const plan = createInstallPlan({ home, nodePath: options.nodePath, port: options.port });
  assertExactOwnedRoots(plan);
  const ownership = await inspectOwnedInstallation(plan);
  const targets = [
    plan.plistPath,
    plan.launcherPath,
    plan.installDir,
    plan.logsDir,
    plan.stateDir,
  ];
  const preview = {
    mode: options.dryRun ? "dry-run" : "uninstall",
    installed: ownership.installed,
    safeToUninstall: ownership.safeToModify,
    ownershipIssues: ownership.issues,
    launchctlAction: ["bootout", `gui/${options.uid ?? process.getuid?.()}/${plan.label}`],
    launchctlSkipped: Boolean(options.skipLaunchctl),
    deleteTargets: targets,
    preserved: [
      "/Applications/ChatGPT.app",
      "/Applications/Codex.app",
      path.join(plan.home, ".codex"),
      "all user projects, media, configuration, and ledgers outside the owned roots",
    ],
  };
  if (options.dryRun || !ownership.installed) return preview;
  if (!options.uninstall) throw new Error("Uninstall requires --uninstall");
  if (!ownership.safeToModify) {
    throw new Error(`Refusing to remove unowned paths: ${ownership.issues.join("; ")}`);
  }

  const bootout = runBootout(plan, options);
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
  }
  return {
    ...preview,
    uninstalled: true,
    launchctlBootoutStatus: bootout?.status ?? null,
    chatGPTOrCodexRestarted: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseUninstallArgs(argv);
  const result = await uninstallMac(options);
  process.stdout.write(`${JSON.stringify(result, null, options.dryRun ? 2 : 0)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
