#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(skillRoot, "assets", "runtime");
const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "manifest.macos.sha256.json"), "utf8"));
const installed = process.argv.includes("--installed");
const homeIndex = process.argv.indexOf("--home");
const home = homeIndex >= 0 ? path.resolve(process.argv[homeIndex + 1] || "") : os.homedir();
if (!path.isAbsolute(home) || home === path.parse(home).root) throw new Error("--home must be an absolute non-root path");
const installRoots = {
  enhancer: path.join(home, "Library", "Application Support", "Codex Sidebar Enhancer"),
  "asset-browser": path.join(home, "Library", "Application Support", "AssetBrowser"),
};

const checks = [];
for (const entry of manifest.files) {
  const [rootName, ...parts] = entry.path.split("/");
  if (installed && entry.path === "asset-browser/asset-browser.config.example.json") continue;
  const absolute = installed
    ? path.join(installRoots[rootName], ...parts)
    : path.join(runtimeRoot, rootName, ...parts);
  let actual = "";
  if (existsSync(absolute)) actual = createHash("sha256").update(await readFile(absolute)).digest("hex");
  checks.push({ name: `${installed ? "installed" : "bundle"}:${entry.path}`, passed: actual === entry.sha256, actual });
}

if (installed) {
  for (const entry of manifest.files.filter((item) => item.path.startsWith("enhancer/asset-console/public/"))) {
    const relative = entry.path.slice("enhancer/asset-console/public/".length);
    const absolute = path.join(installRoots["asset-browser"], "public", ...relative.split("/"));
    const actual = existsSync(absolute) ? createHash("sha256").update(await readFile(absolute)).digest("hex") : "";
    checks.push({ name: `installed:asset-browser/public/${relative}`, passed: actual === entry.sha256, actual });
  }
  const backendRoot = installRoots["asset-browser"];
  const markerPath = path.join(backendRoot, ".codex-workspace-enhancer-runtime-owned");
  const runtimeManifestPath = path.join(backendRoot, ".codex-workspace-enhancer-runtime.json");
  const configPath = path.join(backendRoot, "asset-browser.config.json");
  const tokenPath = path.join(backendRoot, ".api-token");
  const marker = existsSync(markerPath) ? await readFile(markerPath, "utf8") : "";
  checks.push({
    name: "installed:asset-browser ownership marker",
    passed: marker === "Codex Workspace Enhancer AssetBrowser runtime v1\n",
    actual: marker ? "present" : "missing",
  });
  let runtimeManifest = null;
  try { runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8")); } catch {}
  checks.push({
    name: "installed:asset-browser runtime manifest",
    passed: runtimeManifest?.schema === 1 && runtimeManifest?.backendRoot === backendRoot && Array.isArray(runtimeManifest?.runtimeFiles),
    actual: runtimeManifest ? "valid JSON" : "missing or invalid",
  });
  checks.push({
    name: "installed:asset-browser config preserved",
    passed: existsSync(configPath),
    actual: existsSync(configPath) ? "present" : "missing",
  });
  let tokenValid = false;
  let tokenMode = null;
  if (existsSync(tokenPath)) {
    tokenValid = /^[a-f0-9]{64,}$/i.test((await readFile(tokenPath, "utf8")).trim());
    tokenMode = (await stat(tokenPath)).mode & 0o777;
  }
  checks.push({
    name: "installed:asset-browser private API token",
    passed: tokenValid && tokenMode === 0o600,
    actual: tokenValid ? `valid; mode ${tokenMode?.toString(8)}` : "missing or invalid",
  });
}

const failed = checks.filter((check) => !check.passed);
process.stdout.write(`${JSON.stringify({
  passed: failed.length === 0,
  mode: installed ? "installed" : "bundle",
  checkedAt: new Date().toISOString(),
  count: checks.length,
  failed,
}, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
