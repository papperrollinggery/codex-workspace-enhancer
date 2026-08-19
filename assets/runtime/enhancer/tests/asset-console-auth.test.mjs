import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { authenticatedAssetConsoleHeaders, readAssetConsoleApiToken } from "../lib/asset-console-auth.mjs";

test("injector-owned token replaces untrusted iframe headers", () => {
  const token = "a".repeat(64);
  const headers = authenticatedAssetConsoleHeaders({
    "Content-Type": "application/json",
    Origin: "https://web-sandbox.oaiusercontent.com",
    "X-Asset-Console-Token": "attacker-controlled",
  }, token);
  assert.equal(headers["x-asset-console-token"], token);
  assert.equal(headers["X-Asset-Console-Token"], undefined);
  assert.equal(headers.Origin, undefined);
  assert.equal(headers.host, "127.0.0.1:5177");
});

test("token reader validates the private file without exposing its value", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-console-token-"));
  const tokenPath = path.join(temporary, ".api-token");
  try {
    await writeFile(tokenPath, `${"b".repeat(64)}\n`, "utf8");
    assert.equal((await readAssetConsoleApiToken(tokenPath)).length, 64);
    await writeFile(tokenPath, "short\n", "utf8");
    await assert.rejects(readAssetConsoleApiToken(tokenPath), /invalid/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
