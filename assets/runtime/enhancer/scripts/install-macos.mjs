#!/usr/bin/env node

import {
  INSTALL_MANIFEST_FILENAME,
  LAUNCHER_BUNDLE_ID,
  OWNERSHIP_MARKER_CONTENT,
  OWNERSHIP_MARKER_FILENAME,
  PRODUCT_NAME,
  createInstallManifest,
  createInstallPlan,
  validateInstallManifest,
} from "../lib/install-config.mjs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_DIR = path.resolve(SCRIPT_DIR, "..");
const LAUNCHER_SENTINEL = "CodexSidebarEnhancerLauncher:v1";

export function parseInstallArgs(argv) {
  const options = {
    dryRun: false,
    activate: false,
    skipLaunchctl: false,
    launchctlPath: "/bin/launchctl",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--activate" || argument === "--install") options.activate = true;
    else if (argument === "--skip-launchctl") options.skipLaunchctl = true;
    else if (argument === "--bundle-root") options.bundleRoot = requireValue(argv, ++index, argument);
    else if (argument === "--install-dir") options.installDir = requireValue(argv, ++index, argument);
    else if (argument === "--node-path") options.nodePath = requireValue(argv, ++index, argument);
    else if (argument === "--port") options.port = Number(requireValue(argv, ++index, argument));
    else if (argument === "--launchctl-path") options.launchctlPath = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.dryRun === options.activate) {
    throw new Error("Choose exactly one of --dry-run or --activate");
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function resolveBundleSource({ bundleRoot, sourceDir } = {}) {
  if (sourceDir) return path.resolve(sourceDir);
  if (!bundleRoot) return DEFAULT_SOURCE_DIR;
  const resolvedBundleRoot = path.resolve(bundleRoot);
  if (!path.isAbsolute(resolvedBundleRoot)) throw new Error("bundleRoot must be absolute");
  return path.join(resolvedBundleRoot, "enhancer");
}

export async function resolveLaunchdNodePath(explicitPath, {
  envPath = process.env.PATH,
  execPath = process.execPath,
  accessFn = access,
} = {}) {
  if (explicitPath) return path.resolve(explicitPath);
  const candidates = [];
  for (const directory of String(envPath || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, "node"));
  }
  if (path.isAbsolute(execPath)) candidates.push(execPath);
  for (const candidate of [...new Set(candidates)]) {
    try {
      await accessFn(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error("No executable Node.js runtime was found for the LaunchAgent");
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function markerMatches(target) {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return (await readFile(target, "utf8")) === OWNERSHIP_MARKER_CONTENT;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function targetType(target) {
  try {
    const stat = await lstat(target);
    return {
      exists: true,
      symbolicLink: stat.isSymbolicLink(),
      regularFile: stat.isFile() && !stat.isSymbolicLink(),
      directory: stat.isDirectory() && !stat.isSymbolicLink(),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, symbolicLink: false, regularFile: false, directory: false };
    throw error;
  }
}

async function readRegularText(target) {
  const type = await targetType(target);
  if (!type.regularFile) return null;
  return readFile(target, "utf8");
}

async function readRegularJson(target) {
  const text = await readRegularText(target);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for("invalid-json");
  }
}

export async function inspectOwnedInstallation(plan) {
  const targetTypes = {
    installDir: await targetType(plan.installDir),
    stateDir: await targetType(plan.stateDir),
    logsDir: await targetType(plan.logsDir),
    plistPath: await targetType(plan.plistPath),
    launcherPath: await targetType(plan.launcherPath),
  };
  const targetExists = Object.fromEntries(Object.entries(targetTypes).map(([key, value]) => [key, value.exists]));
  const issues = [];
  let installManifest = null;
  let stateManifest = null;
  for (const [key, type] of Object.entries(targetTypes)) {
    if (type.symbolicLink) issues.push(`${key} must not be a symbolic link`);
  }

  if (targetTypes.installDir.directory) {
    if (!(await markerMatches(plan.installMarkerPath))) issues.push("install directory ownership marker is missing or invalid");
    installManifest = await readRegularJson(plan.installManifestPath);
    if (installManifest === Symbol.for("invalid-json")) issues.push("install manifest is invalid JSON");
    else issues.push(...validateInstallManifest(installManifest, plan).map((issue) => `install ${issue}`));
  } else if (targetExists.installDir && !targetTypes.installDir.symbolicLink) {
    issues.push("installDir is not a directory");
  }
  if (targetTypes.stateDir.directory) {
    if (!(await markerMatches(plan.stateMarkerPath))) issues.push("state directory ownership marker is missing or invalid");
    stateManifest = await readRegularJson(plan.stateManifestPath);
    if (stateManifest === Symbol.for("invalid-json")) issues.push("state manifest is invalid JSON");
    else issues.push(...validateInstallManifest(stateManifest, plan).map((issue) => `state ${issue}`));
  } else if (targetExists.stateDir && !targetTypes.stateDir.symbolicLink) {
    issues.push("stateDir is not a directory");
  }
  if (targetTypes.logsDir.directory && !(await markerMatches(plan.logsMarkerPath))) {
    issues.push("logs directory ownership marker is missing or invalid");
  } else if (targetExists.logsDir && !targetTypes.logsDir.directory && !targetTypes.logsDir.symbolicLink) {
    issues.push("logsDir is not a directory");
  }
  if (targetTypes.plistPath.regularFile) {
    const plist = await readRegularText(plan.plistPath);
    if (!plist?.includes(`<string>${plan.label}</string>`) || !plist?.includes("scripts/injector.mjs")) {
      issues.push("LaunchAgent plist is not owned by this installation");
    }
  } else if (targetExists.plistPath && !targetTypes.plistPath.symbolicLink) {
    issues.push("LaunchAgent plist is not a regular file");
  }
  if (targetTypes.launcherPath.directory) {
    const [infoPlist, launcherScript] = await Promise.all([readRegularText(plan.launcherInfoPlistPath), readRegularText(plan.launcherExecutablePath)]);
    if (!infoPlist?.includes(`<string>${LAUNCHER_BUNDLE_ID}</string>`) || !launcherScript?.includes(LAUNCHER_SENTINEL)) {
      issues.push("launcher app is not owned by this installation");
    }
  } else if (targetExists.launcherPath && !targetTypes.launcherPath.symbolicLink) {
    issues.push("launcherPath is not a directory");
  }
  const hasValidManifest = [installManifest, stateManifest].some((manifest) => (
    manifest !== null
    && manifest !== Symbol.for("invalid-json")
    && validateInstallManifest(manifest, plan).length === 0
  ));
  if ((targetExists.plistPath || targetExists.launcherPath) && !hasValidManifest) {
    issues.push("control artifacts are orphaned from a valid install manifest");
  }

  return {
    installed: Object.values(targetExists).some(Boolean),
    safeToModify: issues.length === 0,
    targetExists,
    issues,
    installManifest: installManifest && installManifest !== Symbol.for("invalid-json") ? installManifest : null,
    stateManifest: stateManifest && stateManifest !== Symbol.for("invalid-json") ? stateManifest : null,
  };
}

export async function inspectSupportedApps(appPaths) {
  const apps = [];
  for (const appPath of appPaths) {
    apps.push({ path: appPath, installed: await exists(appPath) });
  }
  return apps;
}

async function validateSourceRuntime(sourceDir) {
  const sourceRealPath = await realpath(sourceDir);
  const required = [
    path.join(sourceRealPath, "package.json"),
    path.join(sourceRealPath, "scripts", "injector.mjs"),
    path.join(sourceRealPath, "scripts", "prepare-owned-profile.mjs"),
    path.join(sourceRealPath, "inject", "conversation-preview.user.js"),
    path.join(sourceRealPath, "panel", "public", "index.html"),
    path.join(sourceRealPath, "panel", "public", "panel.js"),
    path.join(sourceRealPath, "panel", "public", "panel.css"),
    path.join(sourceRealPath, "panel", "public", "module-registry.mjs"),
    path.join(sourceRealPath, "lib", "workspace-panel-bridge.mjs"),
    path.join(sourceRealPath, "lib", "workspace-panel-embed.mjs"),
  ];
  for (const target of required) {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Required runtime file is not a regular file: ${target}`);
  }
  const packageJson = JSON.parse(await readFile(required[0], "utf8"));
  if (packageJson.name !== "codex-sidebar-enhancer") {
    throw new Error(`Unexpected runtime package at ${sourceRealPath}`);
  }
  return { sourceDir: sourceRealPath, version: String(packageJson.version ?? "0.0.0") };
}

function defaultCommandRunner(command, args, options) {
  return spawnSync(command, args, options);
}

function commandError(command, args, result) {
  const detail = String(result?.stderr || result?.error?.message || `exit ${result?.status ?? "unknown"}`).trim();
  return new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}

export function launchctlDomain(uid = process.getuid?.()) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("A numeric user id is required for launchctl");
  return `gui/${uid}`;
}

function runLaunchctl(plan, options, args, { allowFailure = false } = {}) {
  if (options.skipLaunchctl) return { skipped: true, status: 0 };
  const runner = options.commandRunner ?? defaultCommandRunner;
  const result = runner(options.launchctlPath ?? "/bin/launchctl", args, { encoding: "utf8" });
  if (result?.status !== 0 && !allowFailure) throw commandError(options.launchctlPath ?? "/bin/launchctl", args, result);
  return result;
}

async function unloadLaunchAgent(plan, options, domain) {
  if (options.skipLaunchctl) return;
  const service = `${domain}/${plan.label}`;
  const bootout = runLaunchctl(plan, options, ["bootout", service], { allowFailure: true });
  const attempts = options.launchctlUnloadAttempts ?? 70;
  const pollIntervalMs = options.launchctlPollIntervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = runLaunchctl(plan, options, ["print", service], { allowFailure: true });
    if (probe?.status !== 0) return;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (bootout?.status !== 0) throw commandError(options.launchctlPath ?? "/bin/launchctl", ["bootout", service], bootout);
  throw new Error(`LaunchAgent ${service} remained loaded after bootout`);
}

function assertAlternateHomePermission(home, allowAlternateHome) {
  if (path.resolve(home) !== path.resolve(os.homedir()) && !allowAlternateHome) {
    throw new Error("Refusing to install outside the current user's home directory");
  }
}

function transactionPaths(plan, transactionId) {
  if (!/^\d+-\d+$/.test(transactionId)) throw new Error("Invalid transaction id");
  const stagingDir = path.join(path.dirname(plan.installDir), `.${PRODUCT_NAME}.staging-${transactionId}`);
  const transactionDir = path.join(plan.stateDir, "transactions", transactionId);
  if (path.dirname(stagingDir) !== path.dirname(plan.installDir) || !path.basename(stagingDir).startsWith(`.${PRODUCT_NAME}.staging-`)) {
    throw new Error("Unsafe staging path");
  }
  if (path.dirname(transactionDir) !== path.join(plan.stateDir, "transactions")) throw new Error("Unsafe transaction path");
  return { stagingDir, transactionDir };
}

async function copyRuntime(sourceDir, stagingDir) {
  const excluded = new Set([
    path.join(sourceDir, INSTALL_MANIFEST_FILENAME),
    path.join(sourceDir, OWNERSHIP_MARKER_FILENAME),
  ]);
  await cp(sourceDir, stagingDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (candidate) => !excluded.has(path.resolve(candidate)),
  });
}

async function writeAtomic(target, content, mode) {
  const tempPath = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, content, { flag: "wx", mode });
    await rename(tempPath, target);
    if (mode !== undefined) await chmod(target, mode);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function publicPlan(plan, sourceDir, ownership, apps, options) {
  return {
    mode: options.dryRun ? "dry-run" : "activate",
    sourceDir,
    bundleRoot: options.bundleRoot ? path.resolve(options.bundleRoot) : null,
    launchctlSkipped: Boolean(options.skipLaunchctl),
    safeToActivate: ownership.safeToModify,
    ownershipIssues: ownership.issues,
    existingTargets: ownership.targetExists,
    supportedApps: apps,
    label: plan.label,
    port: plan.port,
    nodePath: plan.nodePath,
    ownedRoots: {
      installDir: plan.installDir,
      stateDir: plan.stateDir,
      logsDir: plan.logsDir,
      plistPath: plan.plistPath,
      launcherPath: plan.launcherPath,
    },
    actions: plan.actions,
    appRestartPolicy: "never automatic; a running ChatGPT/Codex is left untouched",
  };
}

export async function installMac(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error(`macOS installer cannot run on ${platform}`);
  const home = options.home ?? os.homedir();
  assertAlternateHomePermission(home, options.allowAlternateHome);
  const nodePath = await resolveLaunchdNodePath(options.nodePath, {
    envPath: options.envPath,
    execPath: options.execPath,
    accessFn: options.accessFn,
  });
  const plan = createInstallPlan({
    home,
    installDir: options.installDir,
    nodePath,
    port: options.port,
  });
  const source = await validateSourceRuntime(resolveBundleSource(options));
  const ownership = await inspectOwnedInstallation(plan);
  const apps = await inspectSupportedApps(plan.supportedAppPaths);
  const preview = publicPlan(plan, source.sourceDir, ownership, apps, options);
  if (options.dryRun) return preview;
  if (!options.activate) throw new Error("Activation requires --activate");
  if (!ownership.safeToModify) {
    throw new Error(`Refusing to modify unowned paths: ${ownership.issues.join("; ")}`);
  }

  await access(plan.nodePath);
  const sourceEqualsInstall = path.resolve(source.sourceDir) === path.resolve(plan.installDir);
  if (sourceEqualsInstall && !ownership.targetExists.installDir) {
    throw new Error("Cannot activate an unowned runtime in place");
  }

  const transactionId = `${Date.now()}-${process.pid}`;
  const { stagingDir, transactionDir } = transactionPaths(plan, transactionId);
  const stateWasPresent = ownership.targetExists.stateDir;
  const logsWerePresent = ownership.targetExists.logsDir;
  const backups = [];
  const modifiedTargets = [];
  let transactionCreated = false;
  let stagingCreated = false;
  const manifest = createInstallManifest(plan, { version: source.version });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const domain = launchctlDomain(options.uid ?? process.getuid?.());

  const backupTarget = async (target, name) => {
    if (await exists(target)) {
      const backupPath = path.join(transactionDir, name);
      await rename(target, backupPath);
      backups.push({ target, backupPath });
    }
    modifiedTargets.push(target);
  };

  try {
    if (!sourceEqualsInstall) {
      if (await exists(stagingDir)) throw new Error(`Refusing to reuse existing staging path: ${stagingDir}`);
      stagingCreated = true;
      await copyRuntime(source.sourceDir, stagingDir);
      await writeFile(path.join(stagingDir, OWNERSHIP_MARKER_FILENAME), OWNERSHIP_MARKER_CONTENT, { mode: 0o600 });
      await writeFile(path.join(stagingDir, INSTALL_MANIFEST_FILENAME), manifestText, { mode: 0o600 });
    }

    await mkdir(plan.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(plan.stateMarkerPath, OWNERSHIP_MARKER_CONTENT, { mode: 0o600 });
    if (await exists(transactionDir)) throw new Error(`Refusing to reuse existing transaction path: ${transactionDir}`);
    await mkdir(transactionDir, { recursive: true, mode: 0o700 });
    transactionCreated = true;
    await mkdir(plan.logsDir, { recursive: true, mode: 0o700 });
    await writeFile(plan.logsMarkerPath, OWNERSHIP_MARKER_CONTENT, { mode: 0o600 });
    await mkdir(plan.launchAgentsDir, { recursive: true });
    await mkdir(path.dirname(plan.launcherPath), { recursive: true });

    await unloadLaunchAgent(plan, options, domain);

    if (!sourceEqualsInstall) {
      await backupTarget(plan.installDir, "runtime.previous");
      await rename(stagingDir, plan.installDir);
    } else {
      await backupTarget(plan.installManifestPath, "install-manifest.previous.json");
      await writeAtomic(plan.installManifestPath, manifestText, 0o600);
    }
    await backupTarget(plan.plistPath, "launch-agent.previous.plist");
    await backupTarget(plan.launcherPath, "launcher.previous.app");
    await backupTarget(plan.stateManifestPath, "state-manifest.previous.json");

    await writeAtomic(plan.stateManifestPath, manifestText, 0o600);
    await writeAtomic(plan.plistPath, plan.plist, 0o644);
    await mkdir(path.dirname(plan.launcherExecutablePath), { recursive: true });
    await writeFile(plan.launcherInfoPlistPath, plan.launcherInfoPlist, { mode: 0o644 });
    await writeFile(plan.launcherExecutablePath, plan.launcherScript, { mode: 0o755 });

    runLaunchctl(plan, options, ["enable", `${domain}/${plan.label}`]);
    runLaunchctl(plan, options, ["bootstrap", domain, plan.plistPath]);
    runLaunchctl(plan, options, ["kickstart", "-k", `${domain}/${plan.label}`]);

    await rm(transactionDir, { recursive: true, force: true });
    return {
      ...preview,
      activated: true,
      rollbackPerformed: false,
      chatGPTOrCodexRestarted: false,
    };
  } catch (error) {
    await unloadLaunchAgent(plan, options, domain);
    for (const target of [...modifiedTargets].reverse()) {
      await rm(target, { recursive: true, force: true });
    }
    for (const { target, backupPath } of [...backups].reverse()) {
      if (await exists(backupPath)) await rename(backupPath, target);
    }
    if (backups.some(({ target }) => target === plan.plistPath)) {
      runLaunchctl(plan, options, ["bootstrap", domain, plan.plistPath], { allowFailure: true });
    }
    if (stagingCreated) await rm(stagingDir, { recursive: true, force: true });
    if (transactionCreated) await rm(transactionDir, { recursive: true, force: true });
    if (!logsWerePresent) await rm(plan.logsDir, { recursive: true, force: true });
    if (!stateWasPresent) await rm(plan.stateDir, { recursive: true, force: true });
    error.message = `${error.message} (installation rolled back)`;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallArgs(argv);
  const result = await installMac(options);
  process.stdout.write(`${JSON.stringify(result, null, options.dryRun ? 2 : 0)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
