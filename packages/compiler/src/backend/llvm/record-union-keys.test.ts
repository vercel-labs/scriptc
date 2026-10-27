import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { BOOL, F64, VOID, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "record-union-keys.ts", start: 0, end: 0 };

async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-union-keys-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return emitLlvmModule(module);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(ir: string, name: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(ir);
  expect(found, name).not.toBeNull();
  return found![0];
}

test("Sets and Maps of record unions key the record pointer", async () => {
  const ir = await llvmFor(`
type Num = { kind: "num"; value: number };
type Neg = { kind: "neg"; operand: Node };
type Add = { kind: "add"; left: Node; right: Node };
type Node = Num | Neg | Add;
const one: Node = { kind: "num", value: 1 };
const nodes: Node[] = [one, { kind: "neg", operand: one }, { kind: "add", left: one, right: one }];
const seen = new Set<Node>();
const depth = new Map<Node, number>();
for (const node of nodes) {
  seen.add(node);
  depth.set(node, node.kind === "num" ? 0 : 1);
}
console.log(seen.size, depth.get(nodes[1]!), seen.has({ kind: "num", value: 1 }));
`);
  // SCR_MAP_KEY_REF (2), never SCR_MAP_KEY_UNION_REF (3), and no union box.
  expect(ir).toMatch(/call ptr @scr_map_new\(i32 2,/);
  expect(ir).not.toMatch(/call ptr @scr_map_new\(i32 3,/);
  expect(ir).not.toMatch(/call ptr @scr_union_new_ref/);
});

const recordType = (shapeId: string): IrType => ({ kind: "record", shapeId });
const wide: IrType = { kind: "union", unionId: "wide" };

/** `pick(u)` answers whether `u` holds arm 0, 2 or 3 of a five-record union
 * through an `||` chain of tag tests; `same` is a second union over the same
 * records in another order. */
function tagChainModule(): IrModule {
  const u: IrExpr = { kind: "varRef", localId: "u", type: wide, loc };
  const isTag = (tag: number): IrExpr => ({
    kind: "unionIsTag",
    unionId: "wide",
    tag,
    negated: false,
    value: u,
    type: BOOL,
    loc,
  });
  const or = (left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "logical",
    op: "||",
    left,
    right,
    type: BOOL,
    loc,
  });
  const shapes = ["a", "b", "c", "d", "e"];
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: shapes.map((id) => ({ id, fields: [{ name: id, type: F64 }] })),
    unions: [
      { id: "wide", arms: shapes.map(recordType) },
      { id: "same", arms: [...shapes].reverse().map(recordType) },
    ],
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [],
        loc,
      },
      {
        name: "pick",
        params: [{ localId: "u", name: "u", type: wide }],
        returnType: BOOL,
        locals: [{ id: "u", name: "u", type: wide, mutable: false }],
        body: [{ kind: "return", value: or(or(isTag(0), isTag(2)), isTag(3)), loc }],
        loc,
      },
      {
        name: "keep",
        params: [{ localId: "s", name: "s", type: { kind: "union", unionId: "same" } }],
        returnType: VOID,
        locals: [
          {
            id: "s",
            name: "s",
            type: { kind: "union", unionId: "same" },
            mutable: false,
          },
        ],
        body: [],
        loc,
      },
    ],
  };
}

test("an || chain of tag tests is one switch on the shape word", () => {
  const mod = tagChainModule();
  expect(validateModule(mod)).toEqual([]);
  const ir = emitLlvmModule(mod, { pointerBits: 64 });
  const pick = body(ir, "sc_bf_pick");
  const switches = pick.match(/switch i32 [^\n]*/g) ?? [];
  expect(switches).toHaveLength(1);
  expect(switches[0]!.match(/label %tags\.y/g)).toHaveLength(3);
  expect(pick).not.toMatch(/@sc_stag\./);
});

test("unions over the same records share one release", () => {
  const ir = emitLlvmModule(tagChainModule(), { pointerBits: 64 });
  expect(ir.match(/^define internal void @sc_srelease\.[^\n]*noinline/gm)).toHaveLength(1);
  expect(ir).toMatch(/^define internal void @sc_srelease\.wide\(/m);
  expect(ir).not.toMatch(/^define internal void @sc_srelease\.same\(/m);
});

test("a union with a freezable arm compares its count without the frozen bit", async () => {
  const ir = await llvmFor(`
type Name = { kind: "name"; text: string };
type Count = { kind: "count"; value: number };
type Key = Name | Count;
function name(text: string): Key {
  const built: Name = { kind: "name", text };
  return Object.freeze(built);
}
const seen = new Set<Key>();
seen.add(name("a"));
seen.add({ kind: "count", value: 1 });
console.log(seen.size);
`);
  const release = /^define internal void @sc_srelease\.[^\n]*\n[^]*?^}/m.exec(ir);
  expect(release).not.toBeNull();
  // SCR_RC_FROZEN is bit 62: a frozen record's last reference has count 1.
  expect(release![0]).toContain("and i64 %rc, -4611686018427387905");
  expect(release![0]).toContain("icmp ult i64 %rcm2, -4611686018427387907");
});
