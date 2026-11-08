import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { runCli } from "./command.js";
import type { CliHost } from "./host.js";
import { callResult, McpServer, MessageReader, toolArgv, toolDefinition, toolName } from "./mcp.js";
import { CLI_COMMANDS, CLI_OPTIONS, type CliCommand } from "./usage.js";

type Json = unknown;
type JsonObject = Record<string, unknown>;

const scratch = mkdtempSync(join(tmpdir(), "scriptc-mcp-test-"));
const declaration = join(scratch, "host.d.ts");
writeFileSync(declaration, "export declare const value: number;\n");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => vi.restoreAllMocks();
});

function command(name: string): CliCommand {
  const found = CLI_COMMANDS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no command ${name}`);
  return found;
}

class Reached extends Error {
  constructor(
    readonly operation: string,
    readonly detail: unknown,
  ) {
    super(operation);
  }
}

let reached: Reached | null = null;

/** A host whose every compiler operation records what reached it and stops the command by
 * throwing, so a test can tell an accepted command line from a refused one. */
function stubHost(platform = "linux"): CliHost {
  const reach =
    (operation: string) =>
    (...detail: unknown[]): never => {
      reached = new Reached(operation, detail);
      throw reached;
    };
  return {
    version: () => "0.0.0-test",
    sourceTargetPlatform: () => platform,
    analyze: reach("analyze"),
    compile: reach("compile"),
    compileLibrary: reach("compileLibrary"),
    resolveProvenanceSources: reach("resolveProvenanceSources"),
    warmNativeCaches: reach("warmNativeCaches"),
    mergeProfiles: reach("mergeProfiles"),
    typePatches: reach("typePatches"),
    run: reach("run"),
    reinvoke: (args) => ({ file: process.execPath, args }),
  };
}

/** Runs the command line and returns what reached the compiler, or the exit status it refused with. */
async function dispatch(argv: string[], platform?: string): Promise<Reached | number> {
  reached = null;
  let status: number;
  try {
    status = await runCli(argv, stubHost(platform));
  } catch (error) {
    if (!(error instanceof Reached)) throw error;
    return error;
  }
  return reached ?? status;
}

const SAMPLES: Record<string, Json> = {
  file: join(scratch, "main.ts"),
  package: "commander",
  selector: "HelpContext.helpWidth",
  type: "| undefined",
  profiles: ["runtime"],
  out: join(scratch, "out"),
  emit: "exe",
  backend: "llvm",
  optimization: "release",
  windows_subsystem: "console",
  libnode: "beside",
  exceptions: "rare",
  target_cpu: "baseline",
  profile_generate: join(scratch, "run-%p.profraw"),
  profile_use: join(scratch, "merged.profdata"),
  emit_lowered: join(scratch, "main.lowered"),
  from_lowered: join(scratch, "main.lowered"),
  from_lowered_accept: ["compiler"],
  ffi: join(scratch, "ffi.json"),
  npm_static: ["auto"],
  define: ['process.env.NODE_ENV="production"'],
  external_types: [`host-module=${declaration}`],
  tier: "auto",
  explain_dynamic: "",
  node_islands: "auto",
  node_island: ["left-pad"],
  native: ["right-pad"],
  node: process.execPath,
  wasm: [join(scratch, "module.wasm")],
  range: "^1.0.0",
  profile: join(scratch, "profile.json"),
  fail_on: "blockers",
  coverage: "reached",
};

function sample(name: string, schema: JsonObject): Json {
  if (schema["type"] === "boolean") return true;
  const value = SAMPLES[name];
  if (value === undefined) throw new Error(`no sample value for ${name}`);
  return value;
}

function requiredArgs(definition: JsonObject): JsonObject {
  const schema = definition["inputSchema"] as JsonObject;
  const properties = schema["properties"] as JsonObject;
  const args: JsonObject = {};
  for (const name of (schema["required"] as string[] | undefined) ?? []) {
    args[name] = sample(name, properties[name] as JsonObject);
  }
  return args;
}

test("every command is one tool with a portable, unique name", () => {
  const names = CLI_COMMANDS.map(toolName);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_]{1,64}$/);
});

test("a tool's properties are unique and its required names exist", () => {
  for (const cmd of CLI_COMMANDS) {
    const schema = toolDefinition(cmd)["inputSchema"] as JsonObject;
    const properties = Object.keys(schema["properties"] as JsonObject);
    const hidden = cmd.diagnostics
      ? cmd.options.filter((option) => option === "print" || option === "explain-island").length
      : 0;
    const declared = cmd.positionals.length + cmd.options.length - hidden;
    expect(properties.length, cmd.name).toBe(declared);
    for (const name of (schema["required"] as string[] | undefined) ?? [])
      expect(properties, cmd.name).toContain(name);
    expect(schema["additionalProperties"]).toBe(false);
  }
});

test("every CLI option belongs to a command or is --help or --version", () => {
  // A command name such as `coverage` is not its option: only `--` words of argv count.
  const used = new Set(
    CLI_COMMANDS.flatMap((cmd) => [
      ...cmd.options,
      ...cmd.argv.filter((word) => word.startsWith("--")).map((word) => word.slice(2)),
    ]),
  );
  for (const option of Object.keys(CLI_OPTIONS)) {
    if (option === "help" || option === "version") continue;
    expect(used.has(option), option).toBe(true);
  }
});

test("the command line accepts every tool with only its required arguments", async () => {
  for (const cmd of CLI_COMMANDS) {
    const outcome = await dispatch(toolArgv(cmd, requiredArgs(toolDefinition(cmd))));
    expect(outcome, cmd.name).toBeInstanceOf(Reached);
  }
});

test("the command line accepts every property of every tool, true and false", async () => {
  let checked = 0;
  for (const cmd of CLI_COMMANDS) {
    const definition = toolDefinition(cmd);
    const properties = (definition["inputSchema"] as JsonObject)["properties"] as JsonObject;
    for (const [name, schema] of Object.entries(properties)) {
      const values =
        (schema as JsonObject)["type"] === "boolean"
          ? [true, false]
          : [sample(name, schema as JsonObject)];
      for (const value of values) {
        const args = { ...requiredArgs(definition), [name]: value };
        const platform = name === "windows_subsystem" ? "win32" : "linux";
        const outcome = await dispatch(toolArgv(cmd, args), platform);
        expect(outcome, `${cmd.name} ${name}=${JSON.stringify(value)}`).toBeInstanceOf(Reached);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(60);
});

test("flag-shaped values stay values", async () => {
  const hostile = "--print=native-link-info";
  const outcome = await dispatch(
    toolArgv(command("build"), { file: hostile, out: "--emit=llvm", node_island: ["-o"] }),
  );
  expect(outcome).toBeInstanceOf(Reached);
  const [entry, options] = (outcome as Reached).detail as [string, Record<string, unknown>];
  expect(entry).toBe(resolve(hostile));
  expect(options["outPath"]).toBe(resolve("--emit=llvm"));
  expect(options["outputKind"]).toBe("exe");
  expect(options["nativeLinkInfo"]).toBeUndefined();
  expect(options["nodeIslands"]).toEqual({ islands: ["-o"] });

  const patch = await dispatch(
    toolArgv(command("types-patch"), {
      package: "--dry-run",
      selector: "--range=*",
      type: "-h",
    }),
  );
  expect(patch).toBeInstanceOf(Reached);
  expect((patch as Reached).detail).toEqual([
    expect.objectContaining({
      action: "patch",
      pkg: "--dry-run",
      selector: "--range=*",
      type: "-h",
      range: null,
      dryRun: false,
    }),
  ]);
});

test("build and coverage always write the diagnostics envelope, and --print is the server's", () => {
  expect(toolArgv(command("build"), { file: "a.ts" })).toEqual([
    "build",
    "--print=diagnostics",
    "--",
    "a.ts",
  ]);
  expect(() => toolArgv(command("build"), { file: "a.ts", print: "native-link-info" })).toThrow(
    /unknown argument "print"/,
  );
  expect(() => toolArgv(command("run"), { file: "a.ts", print: "diagnostics" })).toThrow(
    /unknown argument "print"/,
  );
});

test("wrong types and unknown arguments are refused before anything runs", () => {
  const build = command("build");
  expect(() => toolArgv(build, { file: 1 })).toThrow("file must be a string");
  expect(() => toolArgv(build, { strip: "yes" })).toThrow("strip must be a boolean");
  expect(() => toolArgv(build, { out: ["a"] })).toThrow("out must be a string");
  expect(() => toolArgv(build, { npm_static: "auto" })).toThrow("npm_static must be an array");
  expect(() => toolArgv(build, { npm_static: [["auto"]] })).toThrow("npm_static must be an array");
  expect(() => toolArgv(build, { fail_on: "blockers" })).toThrow(/unknown argument "fail_on"/);
  expect(() => toolArgv(build, { "keep-llvm": true })).toThrow(/unknown argument "keep-llvm"/);
  expect(() => toolArgv(build, JSON.parse('{"__proto__":{"strip":true}}') as JsonObject)).toThrow(
    /unknown argument "__proto__"/,
  );
  expect(() => toolArgv(build, { constructor: "x" })).toThrow(/unknown argument "constructor"/);
  expect(() => toolArgv(command("merge-profiles"), { profiles: "a.profraw" })).toThrow(
    "profiles must be an array of strings",
  );
  expect(toolArgv(build, { file: "a.ts", out: null, keep_llvm: false })).toEqual([
    "build",
    "--no-keep-llvm",
    "--print=diagnostics",
    "--",
    "a.ts",
  ]);
});

function server(): { server: McpServer; sent: JsonObject[] } {
  const sent: JsonObject[] = [];
  return {
    server: new McpServer(stubHost(), (message) => sent.push(message), scratch),
    sent,
  };
}

test("legacy initialize negotiates, and modern requests check their version", () => {
  const { server: mcp, sent } = server();
  mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  mcp.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  mcp.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } },
  });
  mcp.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "server/discover",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  });
  const [echoed, fallback, refused, discovered] = sent as [
    JsonObject,
    JsonObject,
    JsonObject,
    JsonObject,
  ];
  expect((echoed["result"] as JsonObject)["protocolVersion"]).toBe("2025-06-18");
  expect((fallback["result"] as JsonObject)["protocolVersion"]).toBe("2025-11-25");
  expect(refused["error"]).toMatchObject({ code: -32022, data: { requested: "1999-01-01" } });
  expect(discovered["result"]).toMatchObject({
    resultType: "complete",
    supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
    capabilities: { tools: {} },
    cacheScope: "private",
  });
});

test("tools/list returns every tool in command order, cacheable", () => {
  const { server: mcp, sent } = server();
  mcp.handle({ jsonrpc: "2.0", id: "list", method: "tools/list" });
  const result = sent[0]!["result"] as JsonObject;
  expect((result["tools"] as JsonObject[]).map((tool) => tool["name"])).toEqual(
    CLI_COMMANDS.map(toolName),
  );
  expect(result).toMatchObject({ resultType: "complete", cacheScope: "public" });
});

test("malformed messages get JSON-RPC errors and notifications get no answer", () => {
  const { server: mcp, sent } = server();
  mcp.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  mcp.handle(42);
  mcp.handle({ jsonrpc: "2.0", id: null, method: "ping" });
  mcp.handle({ jsonrpc: "2.0", id: { nested: true }, method: "ping" });
  mcp.handle({ jsonrpc: "2.0", id: 5, method: 7 });
  mcp.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  mcp.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "scriptc_nope" } });
  mcp.handle({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "scriptc_run", arguments: ["a.ts"] },
  });
  mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
  mcp.handle({ jsonrpc: "2.0", id: 9, result: {} });
  mcp.handle({ jsonrpc: "2.0", id: 10, method: "ping" });
  expect(
    sent.map((message) => [message["id"], (message["error"] as JsonObject | undefined)?.["code"]]),
  ).toEqual([
    [null, -32600],
    [null, -32600],
    [null, -32600],
    [null, -32600],
    [5, -32600],
    [6, -32601],
    [7, -32602],
    [8, -32602],
    [10, undefined],
  ]);
});

test("invalid tool arguments are tool errors the model can correct", () => {
  const { server: mcp, sent } = server();
  mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "scriptc_run", arguments: { file: "a.ts", shell: "rm -rf /" } },
  });
  expect(sent[0]!["result"]).toMatchObject({ isError: true });
  expect(JSON.stringify(sent[0])).toContain('unknown argument \\"shell\\"');
});

test("an oversized message is refused and the next one still reads", () => {
  const lines: string[] = [];
  let oversized = 0;
  const reader = new MessageReader(
    (line) => lines.push(line),
    () => oversized++,
  );
  const huge = "x".repeat(1024 * 1024);
  reader.push('{"id":1}\n{"id":');
  for (let i = 0; i < 5; i++) reader.push(huge);
  reader.push('2}\n\n{"id"');
  reader.push(":3}\r\n");
  reader.push('{"id":4}');
  reader.end();
  expect(oversized).toBe(1);
  expect(lines).toEqual(['{"id":1}', '{"id":3}\r', '{"id":4}']);
});

test("results carry the diagnostics envelope, or the output as text", () => {
  const envelope = { schema: "scriptc-diagnostics", schemaVersion: 1, success: false };
  const failed = callResult(command("build"), {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(envelope),
    stderr: "",
    truncated: false,
  });
  expect(failed).toMatchObject({
    isError: true,
    structuredContent: { exitCode: 1, diagnostics: envelope },
  });
  const other = callResult(command("build"), {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: '{"schema":"other"}',
    stderr: "warning\n",
    truncated: false,
  });
  expect(other["structuredContent"]).toEqual({
    exitCode: 0,
    stdout: '{"schema":"other"}',
    stderr: "warning\n",
  });
  const killed = callResult(command("run"), {
    exitCode: null,
    signal: "SIGKILL",
    timedOut: true,
    stdout: "partial",
    stderr: "",
    truncated: true,
  });
  expect(killed).toMatchObject({
    isError: true,
    structuredContent: {
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "partial",
      truncated: true,
    },
  });
});
