import { spawn } from "node:child_process";

export class McpStdioClient {
  constructor({ command, args = [], cwd, env, timeoutMs = 10_000, maxLineBytes = 1024 * 1024 } = {}) {
    if (typeof command !== "string" || !command) throw new Error("MCP command is required");
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new Error("MCP args must be strings");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("MCP timeout must be a positive integer");
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 256) throw new Error("MCP line limit must be at least 256 bytes");
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.state = "idle";
    this.child = null;
    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.exitPromise = null;
  }

  async connect() {
    if (this.state === "ready") return;
    if (this.state !== "idle") throw new Error(`Cannot connect MCP client from ${this.state}`);
    this.state = "starting";
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env || process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#acceptStdout(chunk));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8192); });
    this.exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => {
      const wasClosing = this.state === "closing";
      this.state = "closed";
      const detail = code == null ? `signal ${signal || "unknown"}` : `code ${code}`;
      if (!wasClosing) this.#rejectPending(new Error(`MCP child exited with ${detail}`));
      resolve({ code, signal });
    }));
    child.once("error", (error) => this.#fatal(error));
    try {
      await this.#request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex-workspace-panel", version: "1.0.0" },
      });
      this.#write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      this.state = "ready";
    } catch (error) {
      this.#fatal(error);
      throw error;
    }
  }

  async callTool(name, arguments_ = {}) {
    if (this.state !== "ready") throw new Error("MCP client is not ready");
    if (typeof name !== "string" || !name) throw new Error("MCP tool name is required");
    return this.#request("tools/call", { name, arguments: arguments_ });
  }

  async close() {
    if (this.state === "closed") return;
    if (!this.child) {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    this.#rejectPending(new Error("MCP client closed"));
    try { this.child.stdin.end(); } catch {}
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!exited) {
      try { this.child.kill("SIGTERM"); } catch {}
      await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
    this.state = "closed";
  }

  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("MCP stdin is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #acceptStdout(chunk) {
    this.buffer += chunk;
    if (!this.buffer.includes("\n") && Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      this.#fatal(new Error("MCP stdout line exceeded limit"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.#fatal(new Error("MCP stdout line exceeded limit"));
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch {
        this.#fatal(new Error("MCP stdout contained invalid JSON"));
        return;
      }
      if (!Number.isInteger(message.id)) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "MCP request failed"));
      else pending.resolve(message.result);
    }
  }

  #fatal(error) {
    if (this.state !== "closed") this.state = "failed";
    this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
    try { this.child?.kill("SIGTERM"); } catch {}
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
