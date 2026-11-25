import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../src/frontend/program-node.js";
import * as ts from "../src/frontend/ts7/adapter.js";
import { closeSourceParser } from "../src/frontend/ts7/source-parser-node.js";
import { Lowerer, newFnCtx } from "../src/frontend/lowering/lowerer.js";
import { DYN } from "../src/ir/ir.js";
import type { IrStmt } from "../src/ir/ir.js";
import type { ScrDiagnostic } from "../src/diagnostics/diagnostic.js";

afterAll(closeSourceParser);

// A class accessor that reflection lowers a second time over a checked-dynamic
// receiver (the prototype view Object.getPrototypeOf builds) cannot run a
// statement that reads a typed field where the checker requires its own type:
// here a Map keyed by the class's Item field. The attempt owns that
// diagnostic, but the statement must still appear in the lowered body as a
// run-time fence rather than vanish from it.
const source = `
class Item {
  name = "it";
}

const seen: Map<Item, number> = new Map();

class Timer {
  readonly item: Item;
  constructor(item: Item) {
    this.item = item;
  }
  set currentTime(ms: number) {
    const state = seen.get(this.item);
    console.log("time", state === undefined ? -1 : state, ms);
  }
}
`;

function fences(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) fences(item, out);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["kind"] === "runtimeFence") out.push(String(record["message"]));
    for (const [key, value] of Object.entries(record)) if (key !== "loc") fences(value, out);
  }
  return out;
}

test("a reflected TypeScript member keeps a refused statement as a fence", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-reflected-fence-"));
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  const load = loadProgram(entry);
  try {
    checkPreflight(load);
    const lowerer = new Lowerer(load.program, load.entry, load.moduleOrder);
    const sf = load.entry;
    const declaration = sf.statements.nodes.find(
      (node): node is ts.ClassDeclaration =>
        ts.isClassDeclaration(node) && node.name?.text === "Timer",
    );
    expect(declaration).toBeDefined();
    lowerer.collecting = true;
    lowerer.collectClassShape(declaration!);
    lowerer.collecting = false;
    const info = lowerer.classes.get("Timer");
    expect(info).toBeDefined();
    const setter = declaration!.members.nodes.find((member): member is ts.SetAccessorDeclaration =>
      ts.isSetAccessorDeclaration(member),
    );
    expect(setter).toBeDefined();

    // What the prototype view does: lower the accessor with `this` as a
    // checked-dynamic receiver, inside a capture buffer.
    const context = newFnCtx(false, null, null, DYN);
    context.thisBoundary = true;
    const previousClass = lowerer.currentClass;
    lowerer.currentClass = info!;
    lowerer.fnStack.push(context);
    const captured: ScrDiagnostic[] = [];
    lowerer.diagSink = captured;
    try {
      lowerer.lowerLambda(setter!, true);
    } finally {
      lowerer.diagSink = null;
      lowerer.fnStack.pop();
      lowerer.currentClass = previousClass;
    }

    // The attempt reported the refusal into the buffer...
    expect(captured.length).toBeGreaterThan(0);
    // ...and the body it lowered still holds the refused statement's fence.
    const lowered = lowerer.liftedFns.flatMap((fn) => fences(fn.body as IrStmt[]));
    expect(lowered.length).toBeGreaterThan(0);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
