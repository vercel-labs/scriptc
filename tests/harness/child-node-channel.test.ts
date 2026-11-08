import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Node's JSON IPC channel between a compiled program and a Node.js process:
// a compiled parent that forks a script through `execPath`, and a compiled
// child that a Node.js parent starts with an "ipc" stdio entry. Each
// scenario runs twice with the same Node.js program on the other end, once
// with Node.js running the TypeScript source and once with the compiled
// binary, and the two outputs must be equal. (The corpus program
// child-ipc-exec-path.ts runs one program in both roles, so there both ends
// are Node.js or both are compiled.) The last test pins the named refusal of
// V8's "advanced" serialization where it is known only at run time. POSIX
// only: the socket-pair launch is not implemented for Windows targets.
const posix = process.platform !== "win32";

type Ran = { stdout: string; stderr: string; code: number };

async function run(file: string, args: string[]): Promise<Ran> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

async function build(dir: string, name: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-node-channel-out-"));
  const result = await compile(join(dir, `${name}.ts`), {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, name),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  return result.ok ? result.binaryPath : "";
}

function write(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-node-channel-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const PARENT = `import { fork } from "node:child_process";
type Note = { kind: string; n: number; text: string };
const relay = fork(process.argv[2] ?? "", ["north"], {
  execPath: process.argv[3] ?? "",
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
const log: string[] = [];
relay.on("message", (got: Note) => {
  log.push(got.kind + ":" + got.n + ":" + got.text.length);
  if (got.kind === "ready") {
    for (let n = 1; n <= 3; n++) relay.send({ kind: "ticket", n, text: "t".repeat(n) });
    relay.send({ kind: "sheet", n: 4, text: "s".repeat(300000) });
  }
  if (got.n === 4) relay.send({ kind: "bye", n: 5, text: "" });
});
relay.on("disconnect", () => log.push("disconnect:" + relay.connected));
relay.on("close", (code, signal) => {
  console.log(log.join(" "), code, signal, relay.connected);
});
`;

const NODE_CHILD = `let seen = 0;
process.on("message", (got) => {
  seen++;
  if (got.kind === "bye") {
    process.send({ cmd: "NODE_LOOKS_INTERNAL" });
    process.disconnect();
    return;
  }
  process.send({ kind: "echo:" + got.kind + ":" + process.argv[2], n: got.n, text: got.text + got.text });
});
process.send({ kind: "ready", n: 0, text: "" });
`;

const CHILD = `type Note = { kind: string; n: number; text: string };
console.log(typeof process.send, process.connected, String(process.env.NODE_CHANNEL_FD));
let seen = 0;
process.on("message", (got: Note) => {
  seen++;
  if (got.kind === "bye") process.disconnect();
  else process.send?.({ kind: "echo:" + got.kind, n: got.n, text: got.text + got.text });
});
process.on("disconnect", () => {
  console.log("disconnected", process.connected);
});
process.send?.({ kind: "ready", n: 0, text: "" });
`;

const NODE_PARENT = (options: string): string => `import { spawn } from "node:child_process";
const [program, ...rest] = process.argv.slice(2);
const child = spawn(program, rest, { stdio: ["ignore", "inherit", "inherit", "ipc"]${options} });
const log = [];
child.on("message", (got) => {
  log.push(got.kind + ":" + got.n + ":" + got.text.length);
  if (got.kind === "ready") {
    child.send({ kind: "ticket", n: 1, text: "a" });
    child.send({ kind: "sheet", n: 2, text: "s".repeat(300000) });
  }
  if (got.n === 2) child.send({ kind: "bye", n: 3, text: "" });
});
child.on("disconnect", () => log.push("disconnect"));
child.on("close", (code, signal) => {
  console.log(log.join(" "), code, signal);
});
`;

test.skipIf(!posix)(
  "a compiled parent and a Node.js child speak Node's channel as two Node.js processes do",
  async () => {
    const dir = write({ "parent.ts": PARENT, "relay.mjs": NODE_CHILD });
    const args = [join(dir, "relay.mjs"), process.execPath];
    const node = await run(process.execPath, [join(dir, "parent.ts"), ...args]);
    const native = await run(await build(dir, "parent"), args);
    expect(node.stdout).toContain("echo:sheet:north:4:600000 disconnect:false 0 null false");
    expect(native.stdout).toBe(node.stdout);
    expect(native.code).toBe(node.code);
    expect(native.stderr).toBe("");
  },
  240_000,
);

test.skipIf(!posix)(
  "a compiled child takes over the channel a Node.js parent opened, as a Node.js child does",
  async () => {
    const dir = write({ "child.ts": CHILD, "parent.mjs": NODE_PARENT("") });
    const node = await run(process.execPath, [
      join(dir, "parent.mjs"),
      process.execPath,
      join(dir, "child.ts"),
    ]);
    const native = await run(process.execPath, [
      join(dir, "parent.mjs"),
      await build(dir, "child"),
    ]);
    expect(node.stdout).toContain("function true undefined");
    expect(node.stdout).toContain("echo:sheet:2:600000 disconnect 0 null");
    expect(native.stdout).toBe(node.stdout);
    expect(native.code).toBe(node.code);
    expect(native.stderr).toBe("");
  },
  240_000,
);

test.skipIf(!posix)(
  "V8's advanced serialization is refused by name on both sides",
  async () => {
    const dir = write({
      "child.ts": CHILD,
      "parent.mjs": NODE_PARENT(', serialization: "advanced"'),
      "chooser.ts": `import { fork } from "node:child_process";
const how: "json" | "advanced" = process.argv.length > 9 ? "json" : "advanced";
fork(process.argv[2] ?? "", [], { execPath: process.argv[3] ?? "", serialization: how });
console.log("not reached");
`,
    });
    // A compiled child whose parent opened the channel that way stops when
    // it starts, before any of its code runs.
    const child = await run(process.execPath, [join(dir, "parent.mjs"), await build(dir, "child")]);
    expect(child.stdout).toBe("disconnect 1 null\n");
    expect(child.stderr).toContain('serialization: "advanced"');
    expect(child.stderr).toContain("SC2020");
    // A compiled parent that learns the serialization when the call runs
    // throws there.
    const parent = await run(await build(dir, "chooser"), [
      join(dir, "child.ts"),
      process.execPath,
    ]);
    expect(parent.stdout).toBe("");
    expect(parent.code).not.toBe(0);
    expect(parent.stderr).toContain('fork with serialization: "advanced"');
    expect(parent.stderr).toContain("SC2020");
  },
  240_000,
);
