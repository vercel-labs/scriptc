import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

// A JavaScript source defers an unlowered standard-library call to a
// statement-level runtime fence that throws a plain Error. Node throws a
// TypeError for a non-object Object.defineProperty(ies) target and for a
// Symbol where ToNumber/ToIndex is expected, so these calls must reach the
// runtime instead of fencing.
async function lowerJs(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-call-boundaries-"));
  try {
    const entry = join(dir, "main.js");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** libCall fns and expression kinds the module uses, in program order. */
function nodes(mod: IrModule): { fns: string[]; kinds: string[] } {
  const fns: string[] = [];
  const kinds: string[] = [];
  for (const fn of mod.functions) {
    everyStmtList(fn.body, {
      expr: (e) => {
        kinds.push(e.kind);
        if (e.kind === "libCall") fns.push(e.fn);
        return true;
      },
      stmt: () => true,
    });
  }
  return { fns, kinds };
}

test("a primitive defineProperty target reaches the runtime", async () => {
  const mod = await lowerJs(`Object.defineProperty(true, "foo", {});`);
  expect(nodes(mod).fns).toContain("dyn.defineProperty");
});

test("a primitive defineProperties target reaches the runtime", async () => {
  const mod = await lowerJs(`Object.defineProperties(5, { a: {} });`);
  expect(nodes(mod).fns).toContain("dyn.defineProps");
});

test("defineProperty over a plain primitive still evaluates key and descriptor", async () => {
  const mod = await lowerJs(`
    const order = [];
    Object.defineProperty(true, (order.push("key"), "foo"), (order.push("descriptor"), {}));
  `);
  // Both side effects stay ahead of the call, as a seqExpr chain; only the
  // descriptor's evaluation may nest into the dyn call.
  expect(nodes(mod).fns).toContain("dyn.defineProperty");
  expect(nodes(mod).kinds).toContain("seqExpr");
});

test("a Symbol DataView offset converts through the checked-dynamic ToNumber", async () => {
  const mod = await lowerJs(`
    const view = new DataView(new ArrayBuffer(8));
    const s = Symbol("1");
    view.getInt8(s);
    view.setFloat64(0, s);
  `);
  expect(nodes(mod).fns).toContain("js.toNumberCoerce");
});

test("a Symbol typed-array length converts through the checked-dynamic path", async () => {
  const mod = await lowerJs(`
    const s = Symbol("1");
    new Uint8Array(s);
  `);
  // The length boxes into the checked constructor dispatch, whose ToIndex
  // raises Node's Symbol TypeError; no fence diagnostic reaches the caller.
  expect(nodes(mod).kinds).toContain("bytesNew");
  expect(nodes(mod).kinds).toContain("dynFrom");
});
