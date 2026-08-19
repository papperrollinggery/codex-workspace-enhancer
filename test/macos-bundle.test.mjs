import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBundledMac } from "../scripts/install-bundled-macos.mjs";
import { uninstallBundledMac } from "../scripts/uninstall-bundled-macos.mjs";

test("bundled macOS install and uninstall preserve AssetBrowser user state", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-enhancer-test-"));
  const backendRoot = path.join(temporaryHome, "Library", "Application Support", "AssetBrowser");
  const configPath = path.join(backendRoot, "asset-browser.config.json");
  const tokenPath = path.join(backendRoot, ".api-token");
  try {
    const dryRun = await installBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      dryRun: true,
      skipLaunchctl: true,
    });
    assert.equal(dryRun.bundleIntegrity, "verified");
    await assert.rejects(stat(backendRoot), { code: "ENOENT" });

    const installed = await installBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      activate: true,
      skipLaunchctl: true,
    });
    assert.equal(installed.installed, true);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, true);
    assert.match((await readFile(tokenPath, "utf8")).trim(), /^[a-f0-9]{64}$/);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.match(await readFile(path.join(backendRoot, "public", "index.html"), "utf8"), /资产控制台/);

    const removed = await uninstallBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      uninstall: true,
      skipLaunchctl: true,
    });
    assert.equal(removed.uninstalled, true);
    await assert.rejects(stat(path.join(backendRoot, "server.js")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, true);
    assert.match((await readFile(tokenPath, "utf8")).trim(), /^[a-f0-9]{64}$/);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("cross-component failure restores the previous AssetBrowser runtime", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-enhancer-rollback-"));
  const serverPath = path.join(temporaryHome, "Library", "Application Support", "AssetBrowser", "server.js");
  try {
    await installBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      activate: true,
      skipLaunchctl: true,
    });
    await writeFile(serverPath, "previous-backend-runtime\n", "utf8");
    const commandRunner = (_command, args) => ({
      status: args[0] === "bootstrap" ? 1 : 0,
      stderr: args[0] === "bootstrap" ? "injected bootstrap failure" : "",
    });
    await assert.rejects(
      installBundledMac({
        platform: "darwin",
        home: temporaryHome,
        allowAlternateHome: true,
        activate: true,
        commandRunner,
        uid: 501,
      }),
      /AssetBrowser changes were rolled back/,
    );
    assert.equal(await readFile(serverPath, "utf8"), "previous-backend-runtime\n");
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("backend root symlinks fail closed", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-enhancer-symlink-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-enhancer-external-"));
  const backendRoot = path.join(temporaryHome, "Library", "Application Support", "AssetBrowser");
  try {
    await mkdir(path.dirname(backendRoot), { recursive: true });
    await symlink(external, backendRoot, "dir");
    const preview = await installBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      dryRun: true,
      skipLaunchctl: true,
    });
    assert.equal(preview.backend.safeToActivate, false);
    await assert.rejects(installBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      activate: true,
      skipLaunchctl: true,
    }), /Refusing to modify AssetBrowser/);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("uninstaller rejects a manifest that names creative project files", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-enhancer-uninstall-"));
  const backendRoot = path.join(temporaryHome, "Library", "Application Support", "AssetBrowser");
  const runtimeManifestPath = path.join(backendRoot, ".codex-workspace-enhancer-runtime.json");
  const deliveryPath = path.join(backendRoot, "projects", "FinalDelivery", "client-master.mov");
  try {
    await installBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      activate: true,
      skipLaunchctl: true,
    });
    await mkdir(path.dirname(deliveryPath), { recursive: true });
    await writeFile(deliveryPath, "client-delivery\n", "utf8");
    const manifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
    manifest.runtimeFiles.push({ path: "projects/FinalDelivery/client-master.mov", sha256: "forged" });
    await writeFile(runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const preview = await uninstallBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      dryRun: true,
      skipLaunchctl: true,
    });
    assert.equal(preview.backend.safeToUninstall, false);
    await assert.rejects(uninstallBundledMac({
      platform: "darwin",
      home: temporaryHome,
      allowAlternateHome: true,
      uninstall: true,
      skipLaunchctl: true,
    }), /Refusing to remove unowned AssetBrowser files/);
    assert.equal(await readFile(deliveryPath, "utf8"), "client-delivery\n");
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
