import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../index.js";
import type { IrExpr, IrStmt } from "./ir.js";
import { everyStmtList } from "./traverse.js";
import { eachStringField, walkStmtFields } from "./fields.generated.js";

// Programs with many node kinds: classes, closures, async, generators,
// dynamic values, streams and records.
const PROGRAMS = [
  "1003-json-parse-unions.ts",
  "114-live-record-delete.ts",
  "1200-regex-test-basics.ts",
  "1631-inspect-arrays.ts",
  "4900-console-instances.ts",
  "5612-readable-from-iterables.cjs",
  "7110-als-completion-callbacks.ts",
  "7321-speculative-loop-bail-sites.ts",
];

/** The string fields a key walk of `node` finds, as `field=value`. */
function keyWalk(node: IrExpr | IrStmt): string[] {
  const found: string[] = [];
  for (const key in node) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (typeof value === "string") found.push(`${key}=${value}`);
  }
  return found.sort();
}

/** The events of a recursive key walk of `value` that skips `loc` (and
 * `type` with `skipType`): `n:<kind>` for an IR node (an object with a kind
 * and a location; `n:varDecl:<local>` for a declaration), `s:<string>` for
 * each string. */
function keyWalkDeep(value: unknown, events: string[], skipType: boolean): void {
  if (typeof value === "string") events.push(`s:${value}`);
  else if (Array.isArray(value)) for (const item of value) keyWalkDeep(item, events, skipType);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("kind" in record && "loc" in record) events.push(nodeEvent(record as unknown as IrExpr));
    for (const key in record)
      if (key !== "loc" && !(skipType && key === "type"))
        keyWalkDeep(record[key], events, skipType);
  }
}

function nodeEvent(node: IrExpr | IrStmt): string {
  return node.kind === "varDecl" ? `n:varDecl:${node.localId}` : `n:${node.kind}`;
}

async function lowered(program: string, dir: string) {
  const outPath = join(dir, "main.ir.json");
  const entry = join(import.meta.dirname, "../../../../tests/corpus", program);
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return deserializeModule(await readFile(outPath, "utf8"));
}

// A key walk visits a node's fields in the order the lowering created them,
// which can differ from ir.ts's order between sibling fields (a dynKeyGet is
// built key first). The walk's callers count what they find, except that
// declarations must come in the same order.
test("walkStmtFields reports what a recursive key walk finds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-ir-walk-"));
  try {
    for (const program of PROGRAMS) {
      const mod = await lowered(program, dir);
      for (const skipType of [false, true])
        for (const fn of mod.functions) {
          const expected: string[] = [];
          keyWalkDeep(fn.body, expected, skipType);
          const events: string[] = [];
          const walker = {
            node: (node: IrExpr | IrStmt) => events.push(nodeEvent(node)),
            string: (value: string) => events.push(`s:${value}`),
          };
          for (const stmt of fn.body) walkStmtFields(stmt, walker, skipType);
          const where = `${program}: ${fn.name}, skipType ${skipType}`;
          expect([...events].sort(), where).toEqual([...expected].sort());
          const declarations = (list: string[]) => list.filter((e) => e.startsWith("n:varDecl:"));
          expect(declarations(events), where).toEqual(declarations(expected));
        }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("eachStringField reads every string field a key walk of a node finds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-ir-fields-"));
  try {
    for (const program of PROGRAMS) {
      const mod = await lowered(program, dir);
      let nodes = 0;
      const check = (node: IrExpr | IrStmt): boolean => {
        const read: string[] = [];
        eachStringField(node, (value, field) => read.push(`${field}=${value}`));
        expect(read.sort(), `${program}: ${node.kind}`).toEqual(keyWalk(node));
        nodes++;
        return true;
      };
      for (const fn of mod.functions) everyStmtList(fn.body, { expr: check, stmt: check });
      expect(nodes, program).toBeGreaterThan(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
