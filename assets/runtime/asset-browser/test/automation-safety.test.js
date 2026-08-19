import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadAutomation, downloadAssetType, normalizeAutomation } from "../download-automation.js";
import { ExactDuplicateCleaner, normalizeDeduplication } from "../duplicate-cleaner.js";

test("macOS installer formats are classified as installers", () => {
  for (const name of ["Tool.dmg", "Tool.pkg", "Tool.app"]) assert.equal(downloadAssetType(name), "installer", name);
  const config = normalizeAutomation({ inbox: { routes: { installer: "安装包" } } });
  assert.equal(config.inbox.routes.installer, "安装包");
});

test("automatic download routing refuses protected creative destinations", () => {
  const automation = new DownloadAutomation({ ledgerPath: "/tmp/unused-asset-ledger.json" });
  const config = normalizeAutomation({ inbox: { routes: { image: "FinalDelivery" } } });
  assert.throws(() => automation.destinationFor(
    { type: "image", name: "shot.png" },
    config,
    { id: "campaign", name: "Campaign", path: "/tmp/campaign" }
  ), /自动整理\/清理已停止/);
});

test("duplicate cleanup leaves FinalDelivery duplicates untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asset-safety-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const finalDir = path.join(root, "FinalDelivery");
  const quarantinePath = path.join(root, "duplicate-quarantine");
  await fs.mkdir(finalDir, { recursive: true });
  const first = path.join(finalDir, "frame.png");
  const second = path.join(finalDir, "frame-copy.png");
  await fs.writeFile(first, "same-image");
  await fs.writeFile(second, "same-image");
  const old = new Date(Date.now() - 5000);
  await Promise.all([fs.utimes(first, old, old), fs.utimes(second, old, old)]);
  const cleaner = new ExactDuplicateCleaner({ ledgerPath: path.join(root, "ledger.json") });
  const result = await cleaner.inspectCandidate(second, { id: "campaign", name: "Campaign", path: root }, normalizeDeduplication({
    enabled: true,
    settleSeconds: 2,
    quarantinePath
  }));
  assert.deepEqual(result, { keeperPath: null, quarantined: [] });
  assert.equal((await fs.stat(first)).isFile(), true);
  assert.equal((await fs.stat(second)).isFile(), true);
});

test("purge skips protected paths mirrored inside quarantine", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asset-purge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const quarantinePath = path.join(root, "duplicate-quarantine");
  const protectedFile = path.join(quarantinePath, "2020-01-01", "campaign", "生成记录", "frame.png");
  await fs.mkdir(path.dirname(protectedFile), { recursive: true });
  await fs.writeFile(protectedFile, "protected");
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await fs.utimes(protectedFile, old, old);
  const cleaner = new ExactDuplicateCleaner({ ledgerPath: path.join(root, "ledger.json") });
  const purged = await cleaner.purgeExpired({ quarantinePath, retentionDays: 1 });
  assert.deepEqual(purged, []);
  assert.equal((await fs.stat(protectedFile)).isFile(), true);
});
