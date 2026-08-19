#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installMac } from "../assets/runtime/enhancer/scripts/install-macos.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(skillRoot, "assets", "runtime");
const manifestPath = path.join(runtimeRoot, "manifest.macos.sha256.json");
const BACKEND_MARKER = ".codex-workspace-enhancer-runtime-owned";
const BACKEND_MANIFEST = ".codex-workspace-enhancer-runtime.json";
const BACKEND_MARKER_CONTENT = "Codex Workspace Enhancer AssetBrowser runtime v1\n";
const PRESERVED_BACKEND_NAMES = Object.freeze([
  "asset-browser.config.json",
  ".api-token",
  ".asset-download-ledger.json",
  ".generation-tickets.json",
  ".thread-project-bindings.json",
  ".duplicate-cleanup-ledger.json",
  ".rhythm-control-tracks.json",
  ".three-d-reconstruction-tasks.json",
  "action-trash",
  "duplicate-quarantine",
  "prompt-library",
  "canvas",
  "rhythm-control-work",
  "projects",
  "media",
  "FinalDelivery",
  "Final Output",
  "成片",
  "最终输出",
  "生成记录",
  "参考库",
  "AI reference library",
  "daily-practice",
]);

function parseArgs(argv) {
  const options = { dryRun: false, activate: false, skipLaunchctl: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--activate") options.activate = true;
    else if (argument === "--skip-launchctl") options.skipLaunchctl = true;
    else if (argument === "--home") options.home = requireValue(argv, ++index, argument);
    else if (argument === "--node-path") options.nodePath = requireValue(argv, ++index, argument);
    else if (argument === "--port") options.port = Number(requireValue(argv, ++index, argument));
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.dryRun === options.activate) throw new Error("Choose exactly one of --dry-run or --activate");
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function exactPaths(home) {
  const resolvedHome = path.resolve(home);
  if (!path.isAbsolute(resolvedHome) || resolvedHome === path.parse(resolvedHome).root) {
    throw new Error("home must be an absolute non-root path");
  }
  const applicationSupport = path.join(resolvedHome, "Library", "Application Support");
  return Object.freeze({
    home: resolvedHome,
    backendRoot: path.join(applicationSupport, "AssetBrowser"),
    backupRoot: path.join(applicationSupport, "CodexWorkspaceEnhancer", "backups"),
  });
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

async function isSymbolicLink(target) {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoSymlinkChain(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the AssetBrowser root: ${target}`);
  }
  let current = resolvedRoot;
  if (await isSymbolicLink(current)) throw new Error(`AssetBrowser root must not be a symbolic link: ${current}`);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (await isSymbolicLink(current)) throw new Error(`AssetBrowser install path must not contain a symbolic link: ${current}`);
  }
}

async function readManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.format !== "codex-workspace-enhancer-macos-v1" || !Array.isArray(manifest.files)) {
    throw new Error(`Unsupported macOS runtime manifest: ${manifestPath}`);
  }
  return manifest;
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function verifyBundle(manifest) {
  const failures = [];
  for (const entry of manifest.files) {
    const source = path.join(runtimeRoot, ...entry.path.split("/"));
    const actual = await exists(source) ? await sha256(source) : "missing";
    if (actual !== entry.sha256) failures.push({ path: entry.path, expected: entry.sha256, actual });
  }
  if (failures.length) throw new Error(`Bundle integrity failed for ${failures.length} file(s): ${failures[0].path}`);
}

function backendRuntimeEntries(manifest) {
  const entries = manifest.files
    .filter((entry) => entry.path.startsWith("asset-browser/") && !entry.path.endsWith("asset-browser.config.example.json"))
    .map((entry) => ({ ...entry, sourcePath: entry.path, targetPath: entry.path.slice("asset-browser/".length) }));
  for (const entry of manifest.files.filter((item) => item.path.startsWith("enhancer/asset-console/public/"))) {
    entries.push({
      ...entry,
      sourcePath: entry.path,
      targetPath: `public/${entry.path.slice("enhancer/asset-console/public/".length)}`,
    });
  }
  return entries.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
}

function assertRuntimeTarget(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe backend runtime target: ${relativePath}`);
  }
  return target;
}

async function inspectBackend(paths, entries) {
  const markerPath = path.join(paths.backendRoot, BACKEND_MARKER);
  const installManifestPath = path.join(paths.backendRoot, BACKEND_MANIFEST);
  const rootPresent = await exists(paths.backendRoot);
  const marker = await exists(markerPath) ? await readFile(markerPath, "utf8") : null;
  let installedManifest = null;
  if (await exists(installManifestPath)) {
    try { installedManifest = JSON.parse(await readFile(installManifestPath, "utf8")); } catch { installedManifest = Symbol.for("invalid-json"); }
  }
  const collisions = [];
  const issues = [];
  if (rootPresent && await isSymbolicLink(paths.backendRoot)) issues.push("backend root must not be a symbolic link");
  for (const entry of entries) {
    const target = assertRuntimeTarget(paths.backendRoot, entry.targetPath);
    try { await assertNoSymlinkChain(paths.backendRoot, target); } catch (error) { issues.push(error.message); }
    if (await exists(target)) collisions.push(entry.targetPath);
  }
  const managed = marker === BACKEND_MARKER_CONTENT
    && installedManifest !== Symbol.for("invalid-json")
    && installedManifest?.schema === 1
    && installedManifest?.backendRoot === paths.backendRoot
    && Array.isArray(installedManifest?.runtimeFiles);
  for (const protectedName of [BACKEND_MARKER, BACKEND_MANIFEST, "asset-browser.config.json", ".api-token"]) {
    if (await isSymbolicLink(path.join(paths.backendRoot, protectedName))) {
      issues.push(`protected backend file must not be a symbolic link: ${protectedName}`);
    }
  }
  if ((marker !== null || installedManifest !== null) && !managed) issues.push("backend ownership marker or manifest is invalid");
  if (!managed && collisions.length) issues.push(`unowned runtime file collision: ${collisions[0]}`);
  return { rootPresent, managed, collisions, issues, markerPath, installManifestPath };
}

async function copyAtomic(source, target, mode) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.new-${randomUUID()}`);
  await copyFile(source, temporary, constants.COPYFILE_EXCL);
  if (mode !== undefined) await chmod(temporary, mode);
  await rename(temporary, target);
}

async function writeAtomic(target, content, mode) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.new-${randomUUID()}`);
  await writeFile(temporary, content, { mode });
  await rename(temporary, target);
  await chmod(target, mode);
}

async function installBackend(paths, manifest, entries, inspection) {
  if (inspection.issues.length) throw new Error(`Refusing to modify AssetBrowser: ${inspection.issues.join("; ")}`);
  const transactionId = `${Date.now()}-${process.pid}`;
  const transactionRoot = path.join(paths.backupRoot, `AssetBrowser-${transactionId}`);
  const backups = [];
  const created = [];
  const configPath = path.join(paths.backendRoot, "asset-browser.config.json");
  const tokenPath = path.join(paths.backendRoot, ".api-token");
  const runtimeManifest = {
    schema: 1,
    product: "Codex Workspace Enhancer AssetBrowser runtime",
    installedAt: new Date().toISOString(),
    backendRoot: paths.backendRoot,
    runtimeFiles: entries.map((entry) => ({ path: entry.targetPath, sha256: entry.sha256 })),
    preservedNames: PRESERVED_BACKEND_NAMES,
  };

  const backup = async (target, relativeName) => {
    if (await exists(target)) {
      const backupPath = path.join(transactionRoot, relativeName);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(target, backupPath);
      backups.push({ target, backupPath });
    } else {
      created.push(target);
    }
  };

  const rollback = async () => {
    for (const target of [...created].reverse()) await rm(target, { recursive: true, force: true });
    for (const { target, backupPath } of [...backups].reverse()) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(backupPath, target);
    }
    await rm(transactionRoot, { recursive: true, force: true });
  };

  try {
    await mkdir(paths.backendRoot, { recursive: true, mode: 0o700 });
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const source = path.join(runtimeRoot, ...entry.sourcePath.split("/"));
      const target = assertRuntimeTarget(paths.backendRoot, entry.targetPath);
      await assertNoSymlinkChain(paths.backendRoot, target);
      await backup(target, `runtime/${entry.targetPath}`);
      await copyAtomic(source, target, entry.executable ? 0o755 : 0o644);
    }
    await backup(inspection.markerPath, BACKEND_MARKER);
    await backup(inspection.installManifestPath, BACKEND_MANIFEST);
    await writeAtomic(inspection.markerPath, BACKEND_MARKER_CONTENT, 0o600);
    await writeAtomic(inspection.installManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, 0o600);
    if (!await exists(configPath)) {
      const sourceConfig = path.join(runtimeRoot, "asset-browser", "asset-browser.config.example.json");
      await copyAtomic(sourceConfig, configPath, 0o600);
      created.push(configPath);
    }
    if (await exists(tokenPath)) {
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (!/^[a-f0-9]{64,}$/i.test(token)) throw new Error(`Existing AssetBrowser API token is invalid: ${tokenPath}`);
      await chmod(tokenPath, 0o600);
    } else {
      await writeAtomic(tokenPath, `${randomBytes(32).toString("hex")}\n`, 0o600);
      created.push(tokenPath);
    }
    return {
      result: { backendRoot: paths.backendRoot, runtimeFileCount: entries.length, preserved: PRESERVED_BACKEND_NAMES },
      commit: () => rm(transactionRoot, { recursive: true, force: true }),
      rollback,
    };
  } catch (error) {
    await rollback();
    error.message = `${error.message} (AssetBrowser changes rolled back)`;
    throw error;
  }
}

export async function installBundledMac(options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Bundled macOS installer requires macOS");
  const home = path.resolve(options.home ?? os.homedir());
  if (home !== path.resolve(os.homedir()) && !options.allowAlternateHome) {
    throw new Error("Refusing to install outside the current user's home directory");
  }
  const paths = exactPaths(home);
  const manifest = await readManifest();
  await verifyBundle(manifest);
  const entries = backendRuntimeEntries(manifest);
  const backend = await inspectBackend(paths, entries);
  const enhancerPreview = await installMac({
    dryRun: true,
    home,
    allowAlternateHome: options.allowAlternateHome,
    bundleRoot: runtimeRoot,
    nodePath: options.nodePath,
    port: options.port,
    skipLaunchctl: options.skipLaunchctl,
    platform: options.platform,
  });
  const preview = {
    mode: options.dryRun ? "dry-run" : "activate",
    bundleIntegrity: "verified",
    backend: {
      root: paths.backendRoot,
      existingManagedRuntime: backend.managed,
      safeToActivate: backend.issues.length === 0,
      issues: backend.issues,
      runtimeFileCount: entries.length,
      preserves: PRESERVED_BACKEND_NAMES,
    },
    enhancer: enhancerPreview,
    applicationBundlesModified: false,
    applicationRestartPolicy: "never automatic",
  };
  if (options.dryRun) return preview;
  if (!options.activate) throw new Error("Activation requires --activate");
  await access(options.nodePath ?? process.execPath, constants.X_OK);
  const backendTransaction = await installBackend(paths, manifest, entries, backend);
  let enhancerResult;
  try {
    enhancerResult = await installMac({
      activate: true,
      home,
      allowAlternateHome: options.allowAlternateHome,
      bundleRoot: runtimeRoot,
      nodePath: options.nodePath,
      port: options.port,
      skipLaunchctl: options.skipLaunchctl,
      platform: options.platform,
      uid: options.uid,
      commandRunner: options.commandRunner,
    });
  } catch (error) {
    await backendTransaction.rollback();
    error.message = `${error.message}; AssetBrowser changes were rolled back`;
    throw error;
  }
  await backendTransaction.commit();
  return { ...preview, installed: true, backendResult: backendTransaction.result, enhancerResult };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await installBundledMac(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
