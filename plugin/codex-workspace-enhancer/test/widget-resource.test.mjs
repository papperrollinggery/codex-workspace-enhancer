import assert from "node:assert/strict";
import test from "node:test";

import { inlineWidget } from "../mcp/lib/widget-resource.mjs";

test("host bridge fails closed when model-context updates are unavailable", () => {
  const document = inlineWidget({
    html: "<!doctype html><html><head></head><body><script>/* __VISUAL_WORKSPACE_JS__ */</script></body></html>",
    css: "body {}",
    js: "",
    appVersion: "0.2.2",
  });

  assert.match(document, /typeof app\.updateModelContext !== "function"/);
  assert.match(document, /does not support adding Visual Workspace selections to model context/);
  assert.doesNotMatch(document, /api\.sendMessage\s*=/);
});
