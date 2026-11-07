// A handle member table (handle-members.ts) also serves a handle seen
// through no type: a call that names a table member on a dynamic value goes
// through a helper that tests the receiver for the handle kind and calls the
// typed builtin. Only a program that creates such a handle gets helpers.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

interface IrFunctionText {
  name: string;
  body: unknown[];
}

async function functionsOf(file: string, source: string[]): Promise<IrFunctionText[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-handle-member-arms-"));
  try {
    const entry = join(dir, file);
    const outPath = join(dir, "main.ir.json");
    await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
    await writeFile(entry, source.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module.functions as unknown as IrFunctionText[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const helperNames = (functions: IrFunctionText[]): string[] =>
  functions
    .map((fn) => fn.name)
    .filter((name) => name.startsWith("%handle.member."))
    .sort();

test("a member read and called through `any` gets the read-then-call helper", async () => {
  const functions = await functionsOf("main.ts", [
    'import * as dgram from "node:dgram";',
    "function tune(socket: any): number { socket.setRecvBufferSize(8192); return socket.setTTL(64); }",
    'const socket = dgram.createSocket("udp4");',
    'socket.bind(0, "127.0.0.1", () => { console.log(tune(socket)); socket.close(); });',
  ]);
  expect(helperNames(functions)).toEqual([
    "%handle.member.call.setRecvBufferSize.1",
    "%handle.member.call.setTTL.1",
  ]);
  const helper = JSON.stringify(
    functions.find((fn) => fn.name === "%handle.member.call.setRecvBufferSize.1")!.body,
  );
  // The arm: an unanswered member read, the handle kind, a number argument,
  // then the builtin the typed lowering calls.
  expect(helper).toContain('"test":"undefined"');
  expect(helper).toContain('"test":"handle","handleKind":"dgramSocket"');
  expect(helper).toContain('"test":"number"');
  expect(helper).toContain('"fn":"dgram.setRecvBufferSize"');
  // Anything else calls what the member read answered, as before.
  expect(helper).toContain('"kind":"dynCall"');
});

test("a JavaScript method call on a parameter gets the invoke helper", async () => {
  const functions = await functionsOf("main.mjs", [
    'import dgram from "node:dgram";',
    "function tune(socket) { socket.setBroadcast(true); return socket.getRecvBufferSize(); }",
    'const socket = dgram.createSocket("udp4");',
    'socket.bind(0, "127.0.0.1", () => { console.log(tune(socket) > 0); socket.close(); });',
  ]);
  expect(helperNames(functions)).toEqual([
    "%handle.member.invoke.getRecvBufferSize.0",
    "%handle.member.invoke.setBroadcast.1",
  ]);
  const helper = JSON.stringify(
    functions.find((fn) => fn.name === "%handle.member.invoke.setBroadcast.1")!.body,
  );
  expect(helper).toContain('"test":"handle","handleKind":"dgramSocket"');
  expect(helper).toContain('"test":"boolean"');
  expect(helper).toContain('"fn":"dgram.setBroadcast"');
  expect(helper).toContain('"kind":"dynInvoke"');
});

test("an argument count the member does not take gets no helper", async () => {
  const functions = await functionsOf("main.ts", [
    'import * as dgram from "node:dgram";',
    "function tune(socket: any): void { socket.setTTL(1, 2); }",
    'const socket = dgram.createSocket("udp4");',
    "try { tune(socket); } catch { console.log('refused'); }",
    "socket.close();",
  ]);
  expect(helperNames(functions)).toEqual([]);
});

test("a program that creates no table handle lowers as before", async () => {
  const functions = await functionsOf("main.ts", [
    "function tune(socket: any): number { socket.setRecvBufferSize(8192); return socket.setTTL(64); }",
    "console.log(tune({ setRecvBufferSize() {}, setTTL: (ttl: number) => ttl }));",
  ]);
  expect(helperNames(functions)).toEqual([]);
});
