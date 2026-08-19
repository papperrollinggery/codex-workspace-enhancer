import readline from "node:readline";

const mode = process.argv[2] || "normal";
const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "exit" && request.method === "tools/call") process.exit(7);
  if (mode === "timeout" && request.method === "tools/call") return;
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      },
    })}\n`);
    return;
  }
  if (request.method === "tools/call") {
    if (mode === "oversize") {
      process.stdout.write(`${"x".repeat(4096)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999999, result: {} })}\n`);
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: request.params.arguments,
      },
    })}\n`);
  }
});
