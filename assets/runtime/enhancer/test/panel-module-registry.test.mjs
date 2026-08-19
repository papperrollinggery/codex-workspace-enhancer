import assert from "node:assert/strict";
import test from "node:test";

const implementation = await import("../lib/panel-module-registry.mjs").catch(() => ({}));

test("exports a trusted panel module registry", () => {
  assert.equal(typeof implementation.PanelModuleRegistry, "function", "PanelModuleRegistry is missing");
});

test("orders modules and filters missing capabilities", () => {
  const registry = new implementation.PanelModuleRegistry({ capabilities: ["workspace", "git"] });
  registry.register({ id: "changes", label: "变更", order: 20, requiredCapabilities: ["git"], mount() {}, destroy() {} });
  registry.register({ id: "overview", label: "总览", order: 10, requiredCapabilities: ["workspace"], mount() {}, destroy() {} });
  registry.register({ id: "browser", label: "浏览器", order: 30, requiredCapabilities: ["browser"], mount() {}, destroy() {} });
  assert.deepEqual(registry.list().map((entry) => entry.id), ["overview", "changes"]);
});

test("rejects invalid, duplicate, and incomplete modules", () => {
  const registry = new implementation.PanelModuleRegistry();
  assert.throws(() => registry.register({ id: "../escape", label: "Bad", mount() {}, destroy() {} }), /invalid/i);
  assert.throws(() => registry.register({ id: "overview", label: "总览" }), /mount|destroy/i);
  registry.register({ id: "overview", label: "总览", mount() {}, destroy() {} });
  assert.throws(() => registry.register({ id: "overview", label: "重复", mount() {}, destroy() {} }), /duplicate/i);
});

test("destroys every mounted module and clears the registry", async () => {
  const events = [];
  const registry = new implementation.PanelModuleRegistry();
  registry.register({ id: "overview", label: "总览", mount() { events.push("mount"); }, destroy() { events.push("destroy"); } });
  await registry.mount("overview", {});
  await registry.destroyAll();
  assert.deepEqual(events, ["mount", "destroy"]);
  assert.deepEqual(registry.list(), []);
});
