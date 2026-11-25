/** `scriptc mcp`: a Model Context Protocol server over stdio. Every command in `CLI_COMMANDS` is
 * one tool, its input schema comes from the command's positionals and options, and a call runs the
 * command as a child process of this same compiler, so the server shares the command line's
 * parsing, validation and output. */
import { spawn, type ChildProcess } from "node:child_process";
import type { CliHost } from "./host.js";
import {
  CLI_COMMANDS,
  CLI_OPTION_DOCS,
  CLI_OPTIONS,
  type CliCommand,
  type CliOptionName,
} from "./usage.js";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const TOOL_PREFIX = "scriptc_";
const TOOLS_TTL_MS = 86_400_000;
const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const MAX_CONCURRENT_CALLS = 4;
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_DRAIN_MS = 2000;
const DIAGNOSTICS_SCHEMA = "scriptc-diagnostics";

type JsonObject = Record<string, unknown>;

/** A JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** The tool name of a command. */
export function toolName(command: CliCommand): string {
  return TOOL_PREFIX + command.name.replaceAll("-", "_");
}

function propertyName(option: CliOptionName): string {
  return option.replaceAll("-", "_");
}

/** The options a tool exposes: the command's options, less those the diagnostics envelope makes
 * meaningless for commands that write it: `--print`, which the server owns, and
 * `--explain-island`, which only changes the human-readable report. */
function toolOptions(command: CliCommand): readonly CliOptionName[] {
  return command.options.filter(
    (option) => !(command.diagnostics && (option === "print" || option === "explain-island")),
  );
}

function optionSummary(option: CliOptionName): string {
  const doc = CLI_OPTION_DOCS[option] ?? { entries: [] };
  const lines = doc.entries.map((entry) => {
    const text = entry.help.join(" ");
    return `${entry.term.startsWith("--no-") ? "false means " : ""}${entry.term}: ${text}`;
  });
  return [...(doc.summary === undefined ? [] : [doc.summary]), ...lines].join(" ");
}

function optionSchema(option: CliOptionName): JsonObject {
  const config: { type: string; multiple?: boolean; default?: boolean } = CLI_OPTIONS[option];
  const description = optionSummary(option);
  if (config.type === "boolean") {
    return config.default === undefined
      ? { type: "boolean", description }
      : { type: "boolean", default: config.default, description };
  }
  if (config.multiple === true) return { type: "array", items: { type: "string" }, description };
  return { type: "string", description };
}

function outputSchema(command: CliCommand): JsonObject {
  const properties: JsonObject = {
    exitCode: { type: ["integer", "null"], description: "the command's exit status" },
    signal: { type: "string", description: "the signal that ended the command" },
    timedOut: { type: "boolean", description: "the command ran out of time and was stopped" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    truncated: { type: "boolean", description: "stdout or stderr was cut at the output limit" },
  };
  if (command.diagnostics) {
    properties["diagnostics"] = {
      type: "object",
      description: "the scriptc-diagnostics JSON envelope that --print=diagnostics writes",
    };
  }
  return { type: "object", properties, required: ["exitCode"], additionalProperties: false };
}

/** The MCP `Tool` object for a command. */
export function toolDefinition(command: CliCommand): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const positional of command.positionals) {
    properties[positional.name] = positional.variadic
      ? {
          type: "array",
          items: { type: "string" },
          ...(positional.required ? { minItems: 1 } : {}),
          description: positional.summary,
        }
      : { type: "string", description: positional.summary };
    if (positional.required) required.push(positional.name);
  }
  for (const option of toolOptions(command)) {
    properties[propertyName(option)] = optionSchema(option);
    if (command.requiredOptions.includes(option)) required.push(propertyName(option));
  }
  const inputSchema: JsonObject = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) inputSchema["required"] = required;
  const readOnly = command.effect === "read";
  return {
    name: toolName(command),
    title: ["scriptc", ...command.argv].join(" "),
    description: command.usage.map((entry) => `${entry.term}: ${entry.help.join(" ")}`).join("\n"),
    inputSchema,
    outputSchema: outputSchema(command),
    annotations: {
      readOnlyHint: readOnly,
      ...(readOnly ? {} : { destructiveHint: true }),
      openWorldHint: command.effect === "execute" || command.options.includes("provenance-sources"),
    },
  };
}

/** `value` as a JSON object, or null when it is any other JSON value. */
function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** `value` as a list of strings, or an error naming `key`. */
function stringList(key: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  const items: unknown[] = value;
  const list: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") throw new Error(`${key} must be an array of strings`);
    list.push(item);
  }
  return list;
}

/** The command-line arguments, after the executable, that run `command` with tool `args`. Option
 * values are always joined to their flag and positionals follow `--`, so no value can be read as
 * a flag. A null value counts as omitted. */
export function toolArgv(command: CliCommand, args: JsonObject): string[] {
  const options: string[] = [];
  const positionals = new Map<string, string[]>();
  for (const [key, value] of Object.entries(args)) {
    if (value === null) continue;
    const positional = command.positionals.find((candidate) => candidate.name === key);
    if (positional !== undefined) {
      if (positional.variadic) {
        positionals.set(key, stringList(key, value));
      } else {
        if (typeof value !== "string") throw new Error(`${key} must be a string`);
        positionals.set(key, [value]);
      }
      continue;
    }
    const option = toolOptions(command).find((candidate) => propertyName(candidate) === key);
    if (option === undefined) {
      const known = [
        ...command.positionals.map((candidate) => candidate.name),
        ...toolOptions(command).map(propertyName),
      ];
      throw new Error(
        `unknown argument ${JSON.stringify(key)} for ${toolName(command)} (accepted: ${known.join(", ") || "none"})`,
      );
    }
    const config: { type: string; multiple?: boolean } = CLI_OPTIONS[option];
    if (config.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      options.push(value ? `--${option}` : `--no-${option}`);
    } else if (config.multiple === true) {
      for (const item of stringList(key, value)) options.push(`--${option}=${item}`);
    } else {
      if (typeof value !== "string") throw new Error(`${key} must be a string`);
      options.push(`--${option}=${value}`);
    }
  }
  if (command.diagnostics) options.push("--print=diagnostics");
  const trailing = command.positionals.flatMap(
    (positional) => positionals.get(positional.name) ?? [],
  );
  return [...command.argv, ...options, ...(trailing.length > 0 ? ["--", ...trailing] : [])];
}

/** The output a finished child process left. */
interface CallOutput {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Maps a finished command to a `CallToolResult`. A diagnostics envelope on stdout becomes the
 * `diagnostics` field; anything else stays text. */
export function callResult(command: CliCommand, output: CallOutput): JsonObject {
  const structured: JsonObject = { exitCode: output.exitCode };
  if (output.signal !== null) structured["signal"] = output.signal;
  if (output.timedOut) structured["timedOut"] = true;
  let diagnostics: JsonObject | null = null;
  if (command.diagnostics && !output.truncated) {
    try {
      const envelope = asObject(JSON.parse(output.stdout) as unknown);
      if (envelope !== null && envelope["schema"] === DIAGNOSTICS_SCHEMA) diagnostics = envelope;
    } catch {
      diagnostics = null;
    }
  }
  if (diagnostics !== null) structured["diagnostics"] = diagnostics;
  else if (output.stdout !== "") structured["stdout"] = output.stdout;
  if (output.stderr !== "") structured["stderr"] = output.stderr;
  if (output.truncated) structured["truncated"] = true;
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: output.exitCode !== 0,
  };
}

function errorResult(message: string): JsonObject {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { exitCode: null, stderr: message },
    isError: true,
  };
}

/** Collects one output stream up to `MAX_OUTPUT_CHARS`. */
class OutputBuffer {
  text = "";
  truncated = false;

  append(chunk: string): void {
    if (this.truncated) return;
    const room = MAX_OUTPUT_CHARS - this.text.length;
    if (chunk.length <= room) {
      this.text += chunk;
      return;
    }
    this.text += chunk.slice(0, room);
    this.truncated = true;
  }
}

/** Stops a child and every process it started: its process group on POSIX, even after the child
 * itself exited, and its tree on Windows. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null))
    return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
        child.kill();
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

interface RunningCall {
  child: ChildProcess | null;
  cancelled: boolean;
}

/** The protocol state of one server: it answers each message through `write`. */
export class McpServer {
  private readonly running = new Map<string, RunningCall>();
  private readonly idle: (() => void)[] = [];
  private info: JsonObject | null = null;

  constructor(
    private readonly host: Pick<CliHost, "version" | "reinvoke">,
    private readonly write: (message: JsonObject) => void,
    private readonly cwd: string,
  ) {}

  private instructions(): string {
    return (
      "scriptc compiles TypeScript and JavaScript to native executables and WebAssembly. Each tool " +
      "runs the scriptc command of the same name. Start with scriptc_coverage to see what " +
      "compiles and why not; scriptc_build and scriptc_coverage return the JSON diagnostics " +
      "envelope, with an SC code, a location and usually a rewrite hint for each problem. " +
      "scriptc_run compiles and runs a program with its stdin closed and returns its output. " +
      `Relative paths resolve against ${this.cwd}.`
    );
  }

  private serverInfo(): JsonObject {
    this.info ??= { name: "scriptc", version: this.host.version() };
    return this.info;
  }

  /** Handles one parsed message; a request gets exactly one response unless it is cancelled. */
  handle(parsed: unknown): void {
    const message = asObject(parsed);
    if (message === null) {
      this.respondError(
        null,
        new RpcError(-32600, "Invalid Request: expected one JSON-RPC object"),
      );
      return;
    }
    const method = message["method"];
    const id = message["id"];
    if (method === undefined && (message["result"] !== undefined || message["error"] !== undefined))
      return;
    const params = asObject(message["params"]) ?? {};
    if (id === undefined) {
      if (method === "notifications/cancelled") this.cancel(params["requestId"]);
      return;
    }
    if (id === null || (typeof id !== "string" && typeof id !== "number")) {
      this.respondError(
        null,
        new RpcError(-32600, "Invalid Request: id must be a string or number"),
      );
      return;
    }
    if (typeof method !== "string") {
      this.respondError(id, new RpcError(-32600, "Invalid Request: method must be a string"));
      return;
    }
    try {
      this.checkVersion(method, params);
      if (method === "tools/call") {
        this.startCall(id, params);
        return;
      }
      this.respond(id, this.result(method, params));
    } catch (error) {
      this.respondError(
        id,
        error instanceof RpcError ? error : new RpcError(-32603, String(error)),
      );
    }
  }

  /** Resolves once every running call has answered. */
  drain(): Promise<void> {
    return new Promise((resolveIdle) => {
      if (this.running.size === 0) resolveIdle();
      else this.idle.push(resolveIdle);
    });
  }

  /** Stops every running call. */
  stopAll(): void {
    for (const call of this.running.values()) {
      call.cancelled = true;
      if (call.child !== null) killTree(call.child);
    }
  }

  private checkVersion(method: string, params: JsonObject): void {
    const meta = asObject(params["_meta"]);
    if (meta === null) return;
    const requested = meta[PROTOCOL_VERSION_META];
    if (requested === undefined || method === "initialize") return;
    if (requested !== MODERN_VERSION) {
      throw new RpcError(-32022, "Unsupported protocol version", {
        supported: [MODERN_VERSION, ...LEGACY_VERSIONS],
        requested,
      });
    }
  }

  private result(method: string, params: JsonObject): JsonObject {
    if (method === "initialize") {
      const requested = params["protocolVersion"];
      return {
        protocolVersion:
          typeof requested === "string" && LEGACY_VERSIONS.includes(requested)
            ? requested
            : LEGACY_VERSIONS[0]!,
        capabilities: { tools: {} },
        serverInfo: this.serverInfo(),
        instructions: this.instructions(),
      };
    }
    if (method === "server/discover") {
      return {
        supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
        capabilities: { tools: {} },
        instructions: this.instructions(),
        ttlMs: TOOLS_TTL_MS,
        cacheScope: "private",
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") {
      return { tools: CLI_COMMANDS.map(toolDefinition), ttlMs: TOOLS_TTL_MS, cacheScope: "public" };
    }
    throw new RpcError(-32601, `Method not found: ${method}`);
  }

  private startCall(id: string | number, params: JsonObject): void {
    const name = params["name"];
    if (typeof name !== "string") throw new RpcError(-32602, "tools/call needs a tool name");
    const command = CLI_COMMANDS.find((candidate) => toolName(candidate) === name);
    if (command === undefined) throw new RpcError(-32602, `Unknown tool: ${name}`);
    const given = params["arguments"];
    const args = given === undefined || given === null ? {} : asObject(given);
    if (args === null) throw new RpcError(-32602, "tool arguments must be an object");
    const key = JSON.stringify(id);
    if (this.running.has(key)) throw new RpcError(-32600, `request id ${key} is already running`);
    if (this.running.size >= MAX_CONCURRENT_CALLS) {
      this.respond(
        id,
        errorResult(
          `${MAX_CONCURRENT_CALLS} tool calls are already running; retry when one finishes`,
        ),
      );
      return;
    }
    let argv: string[];
    try {
      argv = toolArgv(command, args);
    } catch (error) {
      this.respond(id, errorResult(error instanceof Error ? error.message : String(error)));
      return;
    }
    const call: RunningCall = { child: null, cancelled: false };
    this.running.set(key, call);
    void this.runCall(command, argv, call).then((result) => {
      this.running.delete(key);
      if (!call.cancelled) this.respond(id, result);
      if (this.running.size === 0) for (const resolveIdle of this.idle.splice(0)) resolveIdle();
    });
  }

  private runCall(command: CliCommand, argv: string[], call: RunningCall): Promise<JsonObject> {
    return new Promise((resolveResult) => {
      const invocation = this.host.reinvoke(argv);
      let child: ChildProcess;
      try {
        child = spawn(invocation.file, invocation.args, {
          cwd: this.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (error) {
        resolveResult(errorResult(`cannot start scriptc: ${String(error)}`));
        return;
      }
      call.child = child;
      const stdout = new OutputBuffer();
      const stderr = new OutputBuffer();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, CALL_TIMEOUT_MS);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: string) => stderr.append(chunk));
      let drain: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (result: JsonObject): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (drain !== undefined) clearTimeout(drain);
        resolveResult(result);
      };
      const finish = (exitCode: number | null, signal: string | null): void =>
        settle(
          callResult(command, {
            exitCode,
            signal,
            timedOut,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
          }),
        );
      child.on("error", (error) => settle(errorResult(`cannot start scriptc: ${error.message}`)));
      child.on("exit", (exitCode, signal) => {
        clearTimeout(timer);
        drain = setTimeout(() => {
          child.stdout?.pause();
          child.stderr?.pause();
          finish(exitCode, signal);
        }, OUTPUT_DRAIN_MS);
      });
      child.on("close", (exitCode, signal) => finish(exitCode, signal));
    });
  }

  private cancel(requestId: unknown): void {
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const call = this.running.get(JSON.stringify(requestId));
    if (call === undefined) return;
    call.cancelled = true;
    if (call.child !== null) killTree(call.child);
  }

  private respond(id: string | number, result: JsonObject): void {
    this.write({
      jsonrpc: "2.0",
      id,
      result: {
        ...result,
        resultType: "complete",
        _meta: { [SERVER_INFO_META]: this.serverInfo() },
      },
    });
  }

  private respondError(id: string | number | null, error: RpcError): void {
    const body: JsonObject = { code: error.code, message: error.message };
    if (error.data !== undefined) body["data"] = error.data;
    this.write({ jsonrpc: "2.0", id, error: body });
  }
}

/** Splits newline-delimited messages, refusing any message longer than `MAX_MESSAGE_CHARS`
 * without buffering the rest of it. */
export class MessageReader {
  private buffer = "";
  private discarding = false;

  constructor(
    private readonly onMessage: (line: string) => void,
    private readonly onOversized: () => void,
  ) {}

  push(chunk: string): void {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) break;
      this.finish(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
    }
    this.take(rest);
  }

  end(): void {
    this.finish("");
  }

  private take(text: string): void {
    if (this.discarding) return;
    if (this.buffer.length + text.length > MAX_MESSAGE_CHARS) {
      this.buffer = "";
      this.discarding = true;
      this.onOversized();
      return;
    }
    this.buffer += text;
  }

  private finish(text: string): void {
    const wasDiscarding = this.discarding;
    this.take(text);
    const line = this.buffer;
    this.buffer = "";
    if (wasDiscarding || this.discarding) {
      this.discarding = false;
      return;
    }
    if (line.trim() !== "") this.onMessage(line);
  }
}

/** Serves MCP on stdin and stdout until stdin ends, waits for the running calls, and exits once
 * stdout has flushed: a process a call left behind can still hold one of the server's pipes open,
 * which would otherwise keep it running. A SIGTERM or SIGINT stops every running call first. */
export function serveMcp(host: CliHost): Promise<number> {
  const server = new McpServer(
    host,
    (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    process.cwd(),
  );
  const reader = new MessageReader(
    (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error instanceof Error ? error.message : String(error)}` } })}\n`,
        );
        return;
      }
      server.handle(message);
    },
    () =>
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: message exceeds ${MAX_MESSAGE_CHARS} characters` } })}\n`,
      ),
  );
  return new Promise(() => {
    const decoder = new TextDecoder();
    process.stdin.on("data", (chunk: Uint8Array) =>
      reader.push(decoder.decode(chunk, { stream: true })),
    );
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      reader.push(decoder.decode());
      reader.end();
      void server.drain().then(() => {
        const status = typeof process.exitCode === "number" ? process.exitCode : 0;
        process.stdout.write("", () => process.exit(status));
      });
    };
    const stop = (status: number): void => {
      server.stopAll();
      process.exitCode = status;
      process.stdin.destroy();
      finish();
    };
    process.once("SIGTERM", () => stop(143));
    process.once("SIGINT", () => stop(130));
    process.stdin.on("end", finish);
  });
}
