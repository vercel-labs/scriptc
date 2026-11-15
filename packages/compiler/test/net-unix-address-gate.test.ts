// server.address() lowers to the full AddressInfo record only when no server
// in the program can listen on a Unix socket. A call whose first argument is
// a value the lowering cannot shape — an untyped options bag, a union, a
// BoundSocket, or a `{ handle }` literal naming one — takes the runtime
// ladder, which adopts a path or a bound handle, so the gate must be on for
// it and address() must check the pipe before reading the record.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type Node = { kind?: string; fn?: string; [key: string]: unknown };

async function compileToIr(body: string[], entryName = "main.ts"): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-unix-address-gate-"));
  try {
    const entry = join(dir, entryName);
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown;
    expect(validateModule(module as never)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every IR node of `kind` under `root`. */
function nodesOf(root: unknown, kind: string, found: Node[] = []): Node[] {
  if (Array.isArray(root)) for (const item of root) nodesOf(item, kind, found);
  else if (root !== null && typeof root === "object") {
    const node = root as Node;
    if (node.kind === kind) found.push(node);
    for (const value of Object.values(node)) nodesOf(value, kind, found);
  }
  return found;
}

const pipeChecks = (module: unknown): number =>
  nodesOf(module, "libCall").filter((node) => node.fn === "net.serverAddressCheck").length;

const PRELUDE = [
  'import * as net from "node:net";',
  "function report(server: net.Server): void {",
  "  const info = server.address();",
  "  console.log(info.family, info.port);",
  "}",
];

test("an untyped listen argument keeps the Unix path check on address()", async () => {
  const module = await compileToIr([
    ...PRELUDE,
    "const server = net.createServer();",
    "const options: any = { path: '/tmp/scriptc-gate.sock' };",
    "server.listen(options, () => report(server));",
  ]);
  expect(pipeChecks(module)).toBeGreaterThan(0);
});

test("a union listen argument keeps the Unix path check on address()", async () => {
  const module = await compileToIr([
    ...PRELUDE,
    "const server = net.createServer();",
    "const argument: string | number = process.argv.length > 9 ? '/tmp/scriptc-gate.sock' : 0;",
    "server.listen(argument, () => report(server));",
  ]);
  expect(pipeChecks(module)).toBeGreaterThan(0);
});

test("a listen argument naming a bound handle keeps the check on address()", async () => {
  // The typed ambient does not spell `handle` in its options bag, so the
  // literal form is a JavaScript call site.
  const module = await compileToIr(
    [
      'import * as net from "node:net";',
      "const bound = new net.BoundSocket({ path: '/tmp/scriptc-gate.sock' });",
      "const server = net.createServer();",
      "server.listen({ handle: bound }, () => {",
      "  const info = server.address();",
      "  console.log(info.family, info.port);",
      "});",
    ],
    "main.js",
  );
  expect(pipeChecks(module)).toBeGreaterThan(0);
});

test("a port-only listen leaves the record lowering alone", async () => {
  const module = await compileToIr([
    ...PRELUDE,
    "const server = net.createServer();",
    "server.listen(0, () => report(server));",
  ]);
  expect(pipeChecks(module)).toBe(0);
});
