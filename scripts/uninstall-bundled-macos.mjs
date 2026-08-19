#!/usr/bin/env node

import { lstat, readFile, readdir, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uninstallMac } from "../assets/runtime/enhancer/scripts/uninstall-macos.mjs";

const BACKEND_MARKER = ".codex-workspace-enhancer-runtime-owned";
const BACKEND_MANIFEST = ".codex-workspace-enhancer-runtime.json";
const BACKEND_MARKER_CONTENT = "Codex Workspace Enhancer AssetBrowser runtime v1\n";
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleManifestPath = path.join(skillRoot, "assets", "runtime", "manifest.macos.sha256.json");

async function allowedBackendRuntimeFiles() {
  const bundle = JSON.parse(await readFile(bundleManifestPath, "utf8"));
  if (bundle.format !== "codex-workspace-enhancer-macos-v1" || !Array.isArray(bundle.files)) {
    throw new Error("Current bundle manifest is missing or invalid; refusing to uninstall");
  }
  const allowed = bundle.files
    .filter((entry) => entry.path.startsWith("asset-browser/") && !entry.path.endsWith("asset-browser.config.example.json"))
    .map((entry) => entry.path.slice("asset-browser/".length));
  for (const entry of bundle.files.filter((item) => item.path.startsWith("enhancer/asset-console/public/"))) {
    allowed.push(`public/${entry.path.slice("enhancer/asset-console/public/".length)}`);
  }
  return new Set(allowed);
}

function parseArgs(argv) {
  const options = { dryRun: false, uninstall: false, skipLaunchctl: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--uninstall") options.uninstall = true;
    else if (argument === "--skip-launchctl") options.skipLaunchctl = true;
    else if (argument === "--home") options.home = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.dryRun === options.uninstall) throw new Error("Choose exactly one of --dry-run or --uninstall");
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
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
  let current = path.resolve(root);
  const relative = path.relative(current, path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("backend runtime path escapes the exact root");
  }
  if (await isSymbolicLink(current)) throw new Error("backend root must not be a symbolic link");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (await isSymbolicLink(current)) throw new Error(`backend runtime path contains a symbolic link: ${segment}`);
  }
}

function safeTarget(root, relativePath) {
  const target = path.resolve(root, ...String(relativePath).split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe installed runtime path: ${relativePath}`);
  }
  return target;
}

async function inspectBackend(home, allowedRuntimeFiles) {
  const backendRoot = path.join(home, "Library", "Application Support", "AssetBrowser");
  const markerPath = path.join(backendRoot, BACKEND_MARKER);
  const manifestPath = path.join(backendRoot, BACKEND_MANIFEST);
  const present = await exists(backendRoot);
  if (!present) return { present: false, managed: false, backendRoot, markerPath, manifestPath, runtimeFiles: [], issues: [] };
  const issues = [];
  if (await isSymbolicLink(backendRoot)) issues.push("backend root must not be a symbolic link");
  if (await isSymbolicLink(markerPath)) issues.push("backend ownership marker must not be a symbolic link");
  if (await isSymbolicLink(manifestPath)) issues.push("backend runtime manifest must not be a symbolic link");
  const marker = await exists(markerPath) ? await readFile(markerPath, "utf8") : null;
  if (marker !== BACKEND_MARKER_CONTENT) issues.push("backend runtime ownership marker is missing or invalid");
  let manifest = null;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { issues.push("backend runtime manifest is missing or invalid"); }
  if (manifest?.schema !== 1 || manifest?.backendRoot !== backendRoot || !Array.isArray(manifest?.runtimeFiles)) {
    issues.push("backend runtime manifest ownership does not match the exact root");
  }
  const listedPaths = Array.isArray(manifest?.runtimeFiles)
    ? manifest.runtimeFiles.map((entry) => entry?.path).filter((entry) => typeof entry === "string")
    : [];
  const uniqueListedPaths = new Set(listedPaths);
  if (listedPaths.length !== uniqueListedPaths.size
    || uniqueListedPaths.size !== allowedRuntimeFiles.size
    || [...uniqueListedPaths].some((entry) => !allowedRuntimeFiles.has(entry))) {
    issues.push("backend runtime manifest file list does not match the current owned runtime allowlist");
  }
  const runtimeFiles = [];
  if (!issues.length) {
    for (const entry of manifest.runtimeFiles) {
      if (typeof entry?.path !== "string") {
        issues.push("backend runtime manifest contains an invalid path");
        break;
      }
      const target = safeTarget(backendRoot, entry.path);
      try { await assertNoSymlinkChain(backendRoot, target); } catch (error) { issues.push(error.message); break; }
      runtimeFiles.push(target);
    }
  }
  return { present, managed: issues.length === 0, backendRoot, markerPath, manifestPath, runtimeFiles, issues };
}

async function removeEmptyParents(target, root) {
  let current = path.dirname(target);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      if ((await readdir(current)).length) return;
      await rmdir(current);
      current = path.dirname(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code === "ENOTEMPTY") return;
      throw error;
    }
  }
}

export async function uninstallBundledMac(options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Bundled macOS uninstaller requires macOS");
  const home = path.resolve(options.home ?? os.homedir());
  if (home !== path.resolve(os.homedir()) && !options.allowAlternateHome) {
    throw new Error("Refusing to uninstall outside the current user's home directory");
  }
  const backend = await inspectBackend(home, await allowedBackendRuntimeFiles());
  const enhancerPreview = await uninstallMac({
    dryRun: true,
    home,
    allowAlternateHome: options.allowAlternateHome,
    skipLaunchctl: options.skipLaunchctl,
    platform: options.platform,
    nodePath: options.nodePath,
    uid: options.uid,
    commandRunner: options.commandRunner,
  });
  const preview = {
    mode: options.dryRun ? "dry-run" : "uninstall",
    backend: {
      root: backend.backendRoot,
      installed: backend.present,
      safeToUninstall: !backend.present || backend.managed,
      ownershipIssues: backend.issues,
      runtimeFileCount: backend.runtimeFiles.length,
      preserved: "configuration, token, ledgers, projects, media, creative delivery folders, and every unlisted file",
    },
    enhancer: enhancerPreview,
    applicationBundlesModified: false,
  };
  if (options.dryRun) return preview;
  if (!options.uninstall) throw new Error("Uninstall requires --uninstall");
  if (backend.present && !backend.managed) {
    throw new Error(`Refusing to remove unowned AssetBrowser files: ${backend.issues.join("; ")}`);
  }
  const enhancerResult = await uninstallMac({
    uninstall: true,
    home,
    allowAlternateHome: options.allowAlternateHome,
    skipLaunchctl: options.skipLaunchctl,
    platform: options.platform,
    nodePath: options.nodePath,
    uid: options.uid,
    commandRunner: options.commandRunner,
  });
  if (backend.managed) {
    for (const target of backend.runtimeFiles) {
      await rm(target, { force: true });
      await removeEmptyParents(target, backend.backendRoot);
    }
    await rm(backend.markerPath, { force: true });
    await rm(backend.manifestPath, { force: true });
  }
  return { ...preview, uninstalled: true, enhancerResult };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await uninstallBundledMac(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
