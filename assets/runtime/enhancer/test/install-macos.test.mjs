import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LAUNCH_AGENT_LABEL,
  OWNERSHIP_MARKER_CONTENT,
  createInstallPlan,
  enhancedWindowMarker,
  expectedOwnedPaths,
  isOwnedEnhancedProcessCommand,
  validateInstallManifest,
} from "../lib/install-config.mjs";
import {
  installMac,
  parseInstallArgs,
  resolveBundleSource,
  resolveLaunchdNodePath,
} from "../scripts/install-macos.mjs";
import { uninstallMac } from "../scripts/uninstall-macos.mjs";
import { inspectMac } from "../scripts/inspect-macos.mjs";
import { parseVerifyArgs, verifyMac } from "../scripts/verify-macos.mjs";
import { prepareOwnedProfile } from "../scripts/prepare-owned-profile.mjs";

const ENHANCER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ROOT = "/tmp/codex-enhancer-bundle";

async function withTempHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-enhancer-macos-test-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function installOptions(home, extra = {}) {
  return {
    activate: true,
    platform: "darwin",
    home,
    allowAlternateHome: true,
    sourceDir: ENHANCER_ROOT,
    nodePath: process.execPath,
    skipLaunchctl: true,
    uid: 501,
    ...extra,
  };
}

test("install plan is limited to exact user-owned roots", () => {
  const home = "/tmp/codex-enhancer-plan-home";
  const expected = expectedOwnedPaths(home);
  const plan = createInstallPlan({ home, nodePath: process.execPath });
  assert.equal(plan.installDir, path.join(home, "Library", "Application Support", "Codex Sidebar Enhancer"));
  assert.equal(plan.stateDir, path.join(home, "Library", "Application Support", "CodexSidebarEnhancer"));
  assert.equal(plan.plistPath, path.join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`));
  assert.equal(plan.launcherPath, path.join(home, "Applications", "Codex Sidebar Enhancer.app"));
  assert.deepEqual(
    [plan.installDir, plan.stateDir, plan.logsDir, plan.plistPath, plan.launcherPath],
    [expected.installDir, expected.stateDir, expected.logsDir, expected.plistPath, expected.launcherPath],
  );
  assert.throws(
    () => createInstallPlan({ home, installDir: path.join(home, "Desktop", "Enhancer"), nodePath: process.execPath }),
    /must be exactly/,
  );
  assert.throws(() => createInstallPlan({ home: "/", nodePath: process.execPath }), /must not be a filesystem root/);
});

test("launcher supports ChatGPT and Codex without an automatic restart", () => {
  const plan = createInstallPlan({ home: "/tmp/codex-enhancer-launcher-home", nodePath: process.execPath });
  assert.match(plan.launcherScript, /\/Applications\/ChatGPT\.app/);
  assert.match(plan.launcherScript, /\/Applications\/Codex\.app/);
  assert.match(plan.launcherScript, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(plan.launcherScript, /--user-data-dir=\$\{PROFILE_DIR\}/);
  assert.match(plan.launcherScript, /安装器不会自动重启它/);
  assert.doesNotMatch(plan.launcherScript, /tell application.*to quit/s);
  assert.match(plan.launcherScript, /--mode enhanced-window/);
  assert.match(plan.launcherScript, /attach-existing/);
  assert.match(plan.launcherScript, /MODE="stop"/);
  assert.doesNotMatch(plan.launcherScript, /killall|pkill/u);
  assert.match(plan.launcherScript, new RegExp(enhancedWindowMarker().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(plan.plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(plan.plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("stop ownership rejects an ordinary attach-existing Codex process", () => {
  const ordinary = "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9231";
  const owned = `${ordinary} ${enhancedWindowMarker()}`;
  assert.equal(isOwnedEnhancedProcessCommand(ordinary), false);
  assert.equal(isOwnedEnhancedProcessCommand(owned), true);
  assert.equal(isOwnedEnhancedProcessCommand(owned, { port: 9333 }), false);
});

test("enhanced profile rejects a symlink without touching its external target", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, "owned-state");
    const external = path.join(home, "external-profile");
    const sentinel = path.join(external, "keep.txt");
    await mkdir(stateDir);
    await mkdir(external);
    await chmod(external, 0o755);
    await writeFile(sentinel, "keep\n");
    await symlink(external, path.join(stateDir, "EnhancedProfile"));
    await assert.rejects(prepareOwnedProfile(stateDir), /real directory|escapes/u);
    assert.equal((await stat(external)).mode & 0o777, 0o755);
    assert.equal(await readFile(sentinel, "utf8"), "keep\n");
  });
});

test("enhanced profile creates one real private directory inside owned state", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, "owned-state");
    await mkdir(stateDir);
    const profileDir = await prepareOwnedProfile(stateDir);
    assert.equal(profileDir, await realpath(path.join(stateDir, "EnhancedProfile")));
    assert.equal((await stat(profileDir)).mode & 0o777, 0o700);
  });
});

test("verifier accepts installed and stopped lifecycle contracts", () => {
  assert.deepEqual(
    parseVerifyArgs(["--installed", "--skip-launchctl", "--require-stopped"]),
    {
      installed: true,
      requireStopped: true,
      skipLaunchctl: true,
      skipPlutil: false,
      launchctlPath: "/bin/launchctl",
    },
  );
});

test("argument parser exposes bundle-root and requires an explicit mode", () => {
  const parsed = parseInstallArgs(["--dry-run", "--bundle-root", BUNDLE_ROOT, "--port", "9333"]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.bundleRoot, BUNDLE_ROOT);
  assert.equal(parsed.port, 9333);
  assert.equal(resolveBundleSource(parsed), path.join(BUNDLE_ROOT, "enhancer"));
  assert.throws(() => parseInstallArgs([]), /exactly one/);
  assert.throws(() => parseInstallArgs(["--dry-run", "--activate"]), /exactly one/);
});

test("LaunchAgent defaults to the first executable Node entry on PATH", async () => {
  const checked = [];
  const resolved = await resolveLaunchdNodePath(undefined, {
    envPath: "/stable/bin:/fallback/bin",
    execPath: "/versioned/cellar/node",
    accessFn: async (candidate) => {
      checked.push(candidate);
      if (candidate !== "/stable/bin/node") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(resolved, "/stable/bin/node");
  assert.deepEqual(checked, ["/stable/bin/node"]);
});

test("dry-run returns a clear plan and writes nothing under the provided home", async () => {
  await withTempHome(async (home) => {
    const result = await installMac({
      dryRun: true,
      platform: "darwin",
      home,
      allowAlternateHome: true,
      sourceDir: ENHANCER_ROOT,
      nodePath: process.execPath,
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.safeToActivate, true);
    assert.equal(result.bundleRoot, null);
    assert.match(result.appRestartPolicy, /never automatic/);
    const inspected = await inspectMac({ home, platform: "darwin", skipLaunchctl: true, nodePath: process.execPath });
    assert.equal(inspected.installed, false);
  });
});

test("temporary-home install, verify, and uninstall preserve application bundles", async () => {
  await withTempHome(async (home) => {
    const installed = await installMac(installOptions(home));
    assert.equal(installed.activated, true);
    assert.equal(installed.chatGPTOrCodexRestarted, false);

    const plan = createInstallPlan({ home, nodePath: process.execPath });
    const [installMarker, stateMarker, manifestText] = await Promise.all([
      readFile(plan.installMarkerPath, "utf8"),
      readFile(plan.stateMarkerPath, "utf8"),
      readFile(plan.installManifestPath, "utf8"),
    ]);
    assert.equal(installMarker, OWNERSHIP_MARKER_CONTENT);
    assert.equal(stateMarker, OWNERSHIP_MARKER_CONTENT);
    assert.deepEqual(validateInstallManifest(JSON.parse(manifestText), plan), []);
    assert.match(await readFile(path.join(plan.installDir, "panel", "public", "panel.js"), "utf8"), /PanelModuleRegistry/);

    const verified = await verifyMac({
      home,
      platform: "darwin",
      nodePath: process.execPath,
      skipLaunchctl: true,
      skipPlutil: true,
      requireStopped: true,
      isPortOpen: async () => false,
    });
    assert.equal(verified.ok, true, verified.issues.join("; "));
    assert.equal(verified.checked.applicationBundlesModified, false);
    assert.equal(verified.checked.cdpStopped, true);

    const dryRun = await uninstallMac({
      dryRun: true,
      platform: "darwin",
      home,
      allowAlternateHome: true,
      nodePath: process.execPath,
      skipLaunchctl: true,
      uid: 501,
    });
    assert.equal(dryRun.safeToUninstall, true);
    assert.ok(dryRun.preserved.includes("/Applications/ChatGPT.app"));

    const removed = await uninstallMac({
      uninstall: true,
      platform: "darwin",
      home,
      allowAlternateHome: true,
      nodePath: process.execPath,
      skipLaunchctl: true,
      uid: 501,
    });
    assert.equal(removed.uninstalled, true);
    const after = await inspectMac({ home, platform: "darwin", skipLaunchctl: true, nodePath: process.execPath });
    assert.equal(after.installed, false);
  });
});

test("installer refuses an existing unowned install directory", async () => {
  await withTempHome(async (home) => {
    const plan = createInstallPlan({ home, nodePath: process.execPath });
    await mkdir(plan.installDir, { recursive: true });
    await writeFile(path.join(plan.installDir, "do-not-touch.txt"), "user data\n");
    await assert.rejects(
      installMac(installOptions(home)),
      /Refusing to modify unowned paths/,
    );
    assert.equal(await readFile(path.join(plan.installDir, "do-not-touch.txt"), "utf8"), "user data\n");
  });
});

test("installer refuses owned-root symbolic links without following them", async () => {
  await withTempHome(async (home) => {
    const plan = createInstallPlan({ home, nodePath: process.execPath });
    const outside = await mkdtemp(path.join(os.tmpdir(), "codex-enhancer-symlink-target-"));
    try {
      await mkdir(path.dirname(plan.stateDir), { recursive: true });
      await writeFile(path.join(outside, "do-not-touch.txt"), "outside\n");
      await symlink(outside, plan.stateDir);
      await assert.rejects(installMac(installOptions(home)), /symbolic link/);
      assert.equal(await readFile(path.join(outside, "do-not-touch.txt"), "utf8"), "outside\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("failed launchctl bootstrap restores the previous runtime", async () => {
  await withTempHome(async (home) => {
    await installMac(installOptions(home));
    const plan = createInstallPlan({ home, nodePath: process.execPath });
    const proofPath = path.join(plan.installDir, "rollback-proof.txt");
    await writeFile(proofPath, "previous runtime\n");

    const launchctlCalls = [];
    const commandRunner = (_command, args) => {
      launchctlCalls.push(args);
      return {
        status: args[0] === "print" ? 113 : args[0] === "bootstrap" ? 9 : 0,
        stderr: args[0] === "bootstrap" ? "forced bootstrap failure" : "",
      };
    };
    await assert.rejects(
      installMac(installOptions(home, { skipLaunchctl: false, commandRunner })),
      /installation rolled back/,
    );
    assert.deepEqual(launchctlCalls.slice(0, 6).map((args) => args[0]), ["bootout", "print", "enable", "bootstrap", "bootout", "print"]);
    assert.equal(await readFile(proofPath, "utf8"), "previous runtime\n");
    const inspected = await inspectMac({ home, platform: "darwin", skipLaunchctl: true, nodePath: process.execPath });
    assert.equal(inspected.ownershipSafe, true, inspected.ownershipIssues.join("; "));
  });
});

test("activation bootouts, bootstraps, and kickstarts the user LaunchAgent", async () => {
  await withTempHome(async (home) => {
    const launchctlCalls = [];
    const commandRunner = (command, args) => {
      launchctlCalls.push([command, ...args]);
      return { status: args[0] === "print" ? 113 : 0, stdout: "", stderr: "" };
    };
    await installMac(installOptions(home, { skipLaunchctl: false, commandRunner }));
    assert.deepEqual(launchctlCalls.map((call) => call[1]), ["bootout", "print", "enable", "bootstrap", "kickstart"]);
    assert.match(launchctlCalls[0][2], /^gui\/501\//);
    assert.equal(launchctlCalls[2][2], "gui/501/com.yubowen.codex-sidebar-enhancer");
    assert.equal(launchctlCalls[3][2], "gui/501");
  });
});

test("activation waits until the previous LaunchAgent is actually unloaded", async () => {
  await withTempHome(async (home) => {
    let printCalls = 0;
    const launchctlCalls = [];
    const commandRunner = (_command, args) => {
      launchctlCalls.push(args[0]);
      if (args[0] === "print") {
        printCalls += 1;
        return { status: printCalls < 3 ? 0 : 113, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    await installMac(installOptions(home, {
      skipLaunchctl: false,
      commandRunner,
      launchctlPollIntervalMs: 0,
    }));
    assert.deepEqual(launchctlCalls, ["bootout", "print", "print", "print", "enable", "bootstrap", "kickstart"]);
  });
});

test("uninstaller refuses a tampered ownership marker", async () => {
  await withTempHome(async (home) => {
    await installMac(installOptions(home));
    const plan = createInstallPlan({ home, nodePath: process.execPath });
    await writeFile(plan.stateMarkerPath, "not owned\n");
    await assert.rejects(
      uninstallMac({
        uninstall: true,
        platform: "darwin",
        home,
        allowAlternateHome: true,
        nodePath: process.execPath,
        skipLaunchctl: true,
        uid: 501,
      }),
      /Refusing to remove unowned paths/,
    );
    assert.equal(await readFile(plan.installMarkerPath, "utf8"), OWNERSHIP_MARKER_CONTENT);
  });
});

test("uninstaller fails closed when launchctl cannot stop the service", async () => {
  await withTempHome(async (home) => {
    await installMac(installOptions(home));
    const plan = createInstallPlan({ home, nodePath: process.execPath });
    await assert.rejects(
      uninstallMac({
        uninstall: true,
        platform: "darwin",
        home,
        allowAlternateHome: true,
        nodePath: process.execPath,
        skipLaunchctl: false,
        uid: 501,
        commandRunner: () => ({ status: 77, stderr: "permission denied" }),
      }),
      /owned files were not removed/,
    );
    assert.equal(await readFile(plan.installMarkerPath, "utf8"), OWNERSHIP_MARKER_CONTENT);
  });
});
