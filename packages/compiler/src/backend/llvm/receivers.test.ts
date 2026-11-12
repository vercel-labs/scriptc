import { expect, test } from "vitest";
import { emitLlvmModule, type LlEmitter } from "./emitter.js";
import { type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { emitReadReceiver } from "./receivers.js";

/** A checked element read hands its value to a call through the hidden local
 * the lowering stabilizes it in (`runtimeOptionalPropertyReceiver`). The local
 * keeps the value alive for the whole statement, so the projection the call
 * receives is a borrow: reading it takes no reference of its own. */
const STABILIZED_SOURCE = `
class P {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  dot(o: P): number {
    return this.x * o.x + this.y * o.y;
  }
}
export function total(pts: P[], dir: P): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) sum += pts[i].dot(dir);
  return sum;
}
console.log(total([new P(1, 2)], new P(3, 4)));
`;

async function llvmForSource(source: string): Promise<string> {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { compile, deserializeModule } = await import("../../index.js");
  const dir = await mkdtemp(join(tmpdir(), "scriptc-receivers-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(output, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a stabilized receiver lends its element to the call", async () => {
  const llvm = await llvmForSource(STABILIZED_SOURCE);
  const body = /^define internal double @\S*total\([^]*?^}/m.exec(llvm)![0];
  // The element read lands in the lowering's hidden local and the call reads
  // the projection of it.
  expect(body).toContain("; %propertyRecv");
  expect(body).toMatch(/ = load ptr, ptr %sc_l_\S*propertyRecv/);
  expect(body).toMatch(/call double @\S*dot\(ptr /);
  // Nothing in the borrowed body counts the element down and up per loop.
  expect(body.match(/@sc_retain_P\b/g) ?? []).toHaveLength(0);
  expect(body.match(/@sc_release_P\b/g) ?? []).toHaveLength(0);
});

/** The stabilized local is a sequence's, not the enclosing block's. A checked
 * read lends its projection to a call, and the call may sit in a lazy branch
 * (`a && get().b === c`): a block-scoped local's owner would be released at a
 * scope exit that a path skipping the read also reaches, releasing a stale
 * pointer from an earlier loop iteration. The statements therefore emit in a
 * sequence scope, whose locals transfer to the current statement frame — the
 * frame that releases them on the path that stored them. */
test("a borrowed stabilized read emits its statements in a sequence scope", () => {
  const steps: string[] = [];
  const emitter = {
    stableCallBindings: new Set(["%propertyRecv"]),
    emitInSequenceScope<T>(body: () => T): T {
      steps.push("scope");
      return body();
    },
    emitStmt(s: IrStmt): void {
      steps.push(`stmt:${s.kind}`);
    },
    emitReadReceiver(e: IrExpr) {
      steps.push(`read:${e.kind}`);
      return { name: "%lent", type: e.type };
    },
  } as unknown as LlEmitter;
  const loc = { file: "probe.ts", start: 0, end: 0 };
  const text: IrType = { kind: "string" };
  const read: IrExpr = {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: "%propertyRecv",
        init: { kind: "varRef", localId: "source", type: text, loc },
        loc,
      },
    ],
    result: {
      kind: "unionNarrow",
      unionId: "u1",
      tag: 0,
      value: { kind: "varRef", localId: "%propertyRecv", type: text, loc },
      type: text,
      loc,
    },
    type: text,
    loc,
  };
  const value = emitReadReceiver(emitter, read);
  expect(value.name).toBe("%lent");
  expect(steps).toEqual(["scope", "stmt:varDecl", "read:unionNarrow"]);
});
