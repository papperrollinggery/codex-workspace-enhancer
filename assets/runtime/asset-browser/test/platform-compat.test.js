import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRealPathContained,
  defaultAssetBrowserRoot,
  isPathInside,
  pathKey,
  pathsEqual,
  pythonCandidates,
  resolveAssetBrowserRoot
} from "../platform-compat.js";

test("darwin state defaults to Application Support", () => {
  assert.equal(
    defaultAssetBrowserRoot({ platform: "darwin", env: {}, home: "/Users/tester" }),
    path.join("/Users/tester", "Library", "Application Support", "AssetBrowser")
  );
});

test("explicit root overrides the platform default", () => {
  assert.equal(
    resolveAssetBrowserRoot({ platform: "darwin", env: { ASSET_BROWSER_ROOT: "/tmp/asset-state" }, home: "/Users/tester" }),
    path.resolve("/tmp/asset-state")
  );
});

test("darwin path identity preserves case while Windows folds it", () => {
  const upper = "/tmp/AssetBrowser/ShotA.mov";
  const lower = "/tmp/assetbrowser/shota.mov";
  assert.notEqual(pathKey(upper, { platform: "darwin" }), pathKey(lower, { platform: "darwin" }));
  assert.equal(pathKey(upper, { platform: "win32" }), pathKey(lower, { platform: "win32" }));
  assert.equal(pathsEqual(upper, lower, { platform: "darwin" }), false);
});

test("containment rejects sibling-prefix paths", () => {
  assert.equal(isPathInside("/tmp/project", "/tmp/project/shot.png"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project-copy/shot.png"), false);
});

test("real-path containment rejects a symlink escape", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asset-real-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "asset-real-outside-"));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  await fs.symlink(outside, path.join(root, "escaped"));
  await assert.rejects(
    assertRealPathContained(root, path.join(root, "escaped", "asset.png"), { allowMissing: true }),
    /outside the approved root/
  );
});

test("Python 3 is preferred and Windows fallback never uses a shell", () => {
  assert.deepEqual(pythonCandidates({ platform: "darwin", env: {} })[0], { command: "python3", prefixArgs: [] });
  assert.deepEqual(pythonCandidates({ platform: "win32", env: {} }).slice(0, 3), [
    { command: "python3", prefixArgs: [] },
    { command: "py", prefixArgs: ["-3"] },
    { command: "python", prefixArgs: [] }
  ]);
  assert.equal(pythonCandidates({ platform: "darwin", env: { PYTHON: "/opt/python/bin/python3" } })[0].command, "/opt/python/bin/python3");
});
