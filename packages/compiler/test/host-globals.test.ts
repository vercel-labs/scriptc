/* The host-global table is derived from the compatibility ledger, never
 * typed by hand: a read of a Node 24 global the native runtime does not
 * implement refuses (SC2020, reason "host-global") instead of answering
 * undefined. This test recomputes the derivation and pins the table. */
import { globSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import {
  NODE_GLOBALS_WITHOUT_NATIVE,
  hostGlobalLength,
} from "../src/frontend/lowering/host-globals.js";
import { COMMONJS_MODULE_BINDINGS } from "../src/frontend/builtin-modules.js";

const repoRoot = join(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

interface LedgerRow {
  chapter: string;
  depth: number;
  name?: string;
  nodeStability?: { text?: string };
  static?: { status?: string };
}

/** Node 24 dispatches these only behind a flag (the stability note names
 * the flag), so they are not default globals and a probe for them is a
 * genuine absent-capability probe. */
function flagGated(row: LedgerRow): boolean {
  return /Enable this API with/.test(row.nodeStability?.text ?? "");
}

/** Global names the compiler's bundled declarations know: a read of one is
 * either lowered or a loud runtime SC2020, never a silent undefined. */
function declaredGlobals(): Set<string> {
  const names = new Set<string>();
  for (const file of globSync(join(repoRoot, "packages/compiler/ambient/**/*.d.ts"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /^declare (?:var|const|let|class|function|namespace) ([A-Za-z_$][\w$]*)/gm,
    ))
      names.add(match[1]!);
  }
  return names;
}

test("NODE_GLOBALS_WITHOUT_NATIVE is the ledger's derived set", () => {
  const pin = JSON.parse(read("internal/compatibility/node-v24.json")) as { version: string };
  const ledger = JSON.parse(read("internal/compatibility/generated/node-v24-internal.json")) as {
    nodeVersion: string;
    rows: LedgerRow[];
  };
  expect(ledger.nodeVersion).toBe(pin.version);

  const declared = declaredGlobals();
  const derived = new Set(
    ledger.rows
      .filter(
        (row) =>
          row.chapter === "globals" &&
          row.depth === 1 &&
          row.name !== undefined &&
          !flagGated(row) &&
          row.static?.status === "not-implemented",
      )
      .map((row) => String(row.name).replace(/`/g, ""))
      .filter((name) => !declared.has(name) && !COMMONJS_MODULE_BINDINGS.has(name)),
  );

  // Performance is a Node 24 global the docs' globals chapter omits (Node
  // documents the class under perf_hooks, which has no Performance row
  // either). The design repro's runtime probe pins it as a global whose
  // typeof is "function", so it is the table's one documented extra.
  derived.add("Performance");

  expect([...NODE_GLOBALS_WITHOUT_NATIVE].sort()).toEqual([...derived].sort());
});

test("an imported value with a listed global's name is the program's binding", async () => {
  // The refusal names Node globals, never a name a program binds itself. An
  // import of somebody's `WebSocket` keeps its ordinary lowering in every
  // read form, including one whose declaration the global check would call
  // ambient: the import alias is what proves the name is the program's own
  // binding, whatever it resolves to.
  const dir = await mkdtemp(join(tmpdir(), "scriptc-host-global-"));
  try {
    await writeFile(
      join(dir, "ws.ts"),
      "export declare class WebSocket {\n  constructor(url: string);\n  readonly url: string;\n}\n",
    );
    await writeFile(
      join(dir, "ws.js"),
      "export class WebSocket {\n  constructor(url) {\n    this.url = url;\n  }\n}\n",
    );
    await writeFile(
      join(dir, "main.ts"),
      [
        'import { WebSocket } from "./ws.js";',
        'const socket = new WebSocket("wss://example.test");',
        "const box = { WebSocket };",
        "console.log(socket.url, typeof WebSocket, typeof box.WebSocket);",
        'if (typeof WebSocket === "function") console.log("imported");',
        "",
      ].join("\n"),
    );
    const result = await compile(join(dir, "main.ts"), {
      outDir: join(dir, ".scriptc"),
      outPath: join(dir, ".scriptc", "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok ? [] : result.diagnostics.map((diag) => diag.code)).toEqual([]);
    expect(result.ok).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every listed global's length is Node's, and the value answers it", () => {
  // A read answers a constructor carrying Node's Function length, so a
  // `FormData.length` read must see what Node shows. The table is pinned
  // against the running Node (the release the differential corpus runs).
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of NODE_GLOBALS_WITHOUT_NATIVE) {
    const value = globals[name] as { length?: number } | undefined;
    expect(value, name).toBeDefined();
    expect(typeof value, name).toBe("function");
    expect(hostGlobalLength(name), name).toBe(value!.length);
  }
});

test("a read compiles and answers the constructor; construction refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-host-global-value-"));
  const compileSource = async (name: string, source: string) => {
    await writeFile(join(dir, `${name}.ts`), source);
    return compile(join(dir, `${name}.ts`), {
      outDir: join(dir, ".scriptc"),
      outPath: join(dir, ".scriptc", `${name}.ir.json`),
      outputKind: "ir",
    });
  };
  try {
    // The eager module-init read shape (effect's Schema): a read is not a
    // use, so the module compiles.
    const read = await compileSource(
      "read",
      [
        "declare var FormData: { new (): unknown; readonly prototype: object };",
        "declare var WebSocket: { new (url: string): unknown; readonly prototype: object };",
        "const eager = FormData;",
        "console.log(typeof FormData, FormData.name, FormData.length);",
        "const scope = globalThis as unknown as { FormData: unknown };",
        "console.log(typeof WebSocket, eager === FormData, scope.FormData === FormData);",
        "console.log({} instanceof FormData, FormData.prototype.constructor === FormData);",
        'if (typeof WebSocket === "function") console.log("websocket");',
        "",
      ].join("\n"),
    );
    expect(read.ok ? [] : read.diagnostics.map((diag) => diag.code)).toEqual([]);

    // Constructing or calling the value, or reading a member it does not
    // carry, is the use that refuses.
    for (const [name, expression] of [
      ["construct", "new FormData()"],
      ["call", "FormData()"],
      ["globalThis", "new (globalThis as unknown as { WebSocket: new () => unknown }).WebSocket()"],
      ["static", "(FormData as unknown as { OPEN: number }).OPEN"],
      ["prototype", "(FormData as any).prototype.append()"],
    ] as const) {
      const result = await compileSource(
        name,
        `declare var FormData: { new (): unknown; (): unknown; readonly prototype: object };\n${expression};\n`,
      );
      expect(result.ok, name).toBe(false);
      expect(
        result.ok ? [] : result.diagnostics.map((diag) => [diag.code, diag.reason]),
        name,
      ).toEqual([["SC2020", "host-global"]]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
