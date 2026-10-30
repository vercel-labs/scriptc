import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { findInitializerBindings } from "../src/ir/initializer-bindings.js";
import { analyzeInt32Slots, dynamicFieldStores, Int32Slots } from "../src/ir/int32-slots.js";
import type { IrExpr, IrModule } from "../src/ir/ir.js";
import { IrNodeIndex } from "../src/ir/node-index.js";
import { unshareNodes } from "../src/ir/unshare.js";

// Programs with int32 fields, parameters, results, captured boxes, contract
// pins, int32 arrays and disqualified candidates.
const PROGRAMS = [
  "4451-int32-field-storage.ts",
  "4452-int32-field-dynamic-writes.ts",
  "4453-int32-closed-locals.ts",
  "4630-contract-int32.ts",
  "4970-int32-call-abi.ts",
  "5323-int32-nonnegative-slot-facts.ts",
  "5332-int32-narrowed-slot-facts.ts",
  "5930-contract-int32-arrays.ts",
  "7326-int32-element-arrays.ts",
  "7580-int32-arrays-across-calls.ts",
];

async function lower(program: string, dir: string): Promise<string> {
  const entry = join(import.meta.dirname, "../../../tests/corpus", program);
  const outPath = join(dir, `${program}.ir.json`);
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFile(outPath, "utf8");
}

/** The analysis LlEmitter makes of `mod`, with its node index. */
function analyze(mod: IrModule): { nodes: IrNodeIndex; slots: Int32Slots } {
  const nodes = new IrNodeIndex(mod);
  const slots = analyzeInt32Slots(mod, {
    nodes,
    dynamicStores: dynamicFieldStores(mod, undefined, undefined, nodes),
    initializerBindings: findInitializerBindings(mod, nodes),
  });
  return { nodes, slots };
}

// A forked process holds its own copy of the module: the encoded analysis
// names nodes by index position, which resolve in any copy of the module.
test("the int32 slot analysis decodes against another copy of its module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-transfer-"));
  try {
    let provenWrites = 0;
    for (const program of PROGRAMS) {
      const ir = await lower(program, dir);
      const first = analyze(unshareNodes(deserializeModule(ir)));
      const copy = unshareNodes(deserializeModule(ir));
      const second = analyze(copy);
      const text = first.slots.encode(first.nodes);
      expect(text, program).not.toBeNull();
      const decoded = Int32Slots.decode(text!, copy, second.nodes);
      expect(decoded, program).toEqual(second.slots);
      for (const node of decoded.provenWrites)
        expect(second.slots.provenWrites.has(node), program).toBe(true);
      provenWrites += decoded.provenWrites.size;
    }
    expect(provenWrites).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("an analysis whose proven writes the index does not record does not encode", () => {
  const loc = { file: "test.ts", start: 0, end: 0 };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: "test.ts",
    entry: "%main",
    functions: [
      { loc, name: "%main", params: [], locals: [], returnType: { kind: "void" }, body: [] },
    ],
  };
  const { nodes, slots } = analyze(mod);
  expect(slots.encode(nodes)).not.toBeNull();
  const elsewhere: IrExpr = { loc, kind: "numLit", value: 1, type: { kind: "f64" } };
  slots.provenWrites.add(elsewhere);
  expect(nodes.expressionPositions(slots.provenWrites)).toBeNull();
  expect(slots.encode(nodes)).toBeNull();
});
