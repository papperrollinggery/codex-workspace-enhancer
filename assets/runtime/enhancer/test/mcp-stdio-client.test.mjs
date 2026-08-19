import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const implementation = await import("../lib/mcp-stdio-client.mjs").catch(() => ({}));
const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));

test("exports a bounded MCP stdio client", () => {
  assert.equal(typeof implementation.McpStdioClient, "function", "McpStdioClient is not implemented");
});

test("connects, ignores unknown response ids, calls a tool, and closes", async () => {
  const client = new implementation.McpStdioClient({ command: process.execPath, args: [fixture] });
  await client.connect();
  assert.equal(client.state, "ready");
  const result = await client.callTool("echo", { value: 7 });
  assert.equal(result.structuredContent.value, 7);
  await client.close();
  assert.equal(client.state, "closed");
});

test("times out a pending request and remains closeable", async () => {
  const client = new implementation.McpStdioClient({ command: process.execPath, args: [fixture, "timeout"], timeoutMs: 200 });
  await client.connect();
  await assert.rejects(client.callTool("echo", {}), /timed out/i);
  await client.close();
});

test("rejects pending requests when the child exits", async () => {
  const client = new implementation.McpStdioClient({ command: process.execPath, args: [fixture, "exit"] });
  await client.connect();
  await assert.rejects(client.callTool("echo", {}), /exited.*7/i);
  await client.close();
});

test("rejects an oversized stdout line", async () => {
  const client = new implementation.McpStdioClient({ command: process.execPath, args: [fixture, "oversize"], maxLineBytes: 1024 });
  await client.connect();
  await assert.rejects(client.callTool("echo", {}), /line.*limit/i);
  await client.close();
});
