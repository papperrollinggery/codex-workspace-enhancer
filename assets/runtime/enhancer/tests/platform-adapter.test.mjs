import assert from "node:assert/strict";
import test from "node:test";

import {
  assetBrowserRoot,
  isSupportedDesktopPlatform,
  resolvedTimeZone,
} from "../lib/platform-adapter.mjs";
import { selectMainCodexTarget } from "../scripts/cdp-client.mjs";

test("uses the macOS Application Support root", () => {
  assert.equal(
    assetBrowserRoot({ platform: "darwin", env: {}, home: "/Users/example" }),
    "/Users/example/Library/Application Support/AssetBrowser",
  );
});

test("honors an explicit AssetBrowser root", () => {
  assert.equal(
    assetBrowserRoot({
      platform: "darwin",
      env: { ASSET_BROWSER_ROOT: "/Volumes/Work/AssetBrowser" },
      home: "/Users/example",
    }),
    "/Volumes/Work/AssetBrowser",
  );
});

test("fails closed on unsupported desktop platforms", () => {
  assert.equal(assetBrowserRoot({ platform: "linux", env: {}, home: "/home/example" }), null);
  assert.equal(isSupportedDesktopPlatform("linux"), false);
});

test("uses a configured time zone without guessing", () => {
  assert.equal(resolvedTimeZone({ env: { CODEX_ENHANCER_TIME_ZONE: "Asia/Shanghai" } }), "Asia/Shanghai");
});

test("prefers the exact Codex renderer and ignores unrelated pages", () => {
  const exact = {
    id: "codex-main",
    type: "page",
    title: "Codex",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/exact",
  };
  const targets = [
    {
      id: "external",
      type: "page",
      title: "ChatGPT",
      url: "https://chatgpt.com/",
      webSocketDebuggerUrl: "ws://127.0.0.1/external",
    },
    {
      id: "app-fallback",
      type: "page",
      title: "ChatGPT",
      url: "app://-/workspace",
      webSocketDebuggerUrl: "ws://127.0.0.1/fallback",
    },
    exact,
  ];
  assert.equal(selectMainCodexTarget(targets), exact);
});

test("accepts an app-scheme ChatGPT renderer after UI drift", () => {
  const fallback = {
    id: "app-fallback",
    type: "page",
    title: "ChatGPT",
    url: "app://-/workspace",
    webSocketDebuggerUrl: "ws://127.0.0.1/fallback",
  };
  assert.equal(selectMainCodexTarget([fallback]), fallback);
  assert.equal(selectMainCodexTarget([{
    ...fallback,
    url: "https://chatgpt.com/",
  }]), undefined);
});
