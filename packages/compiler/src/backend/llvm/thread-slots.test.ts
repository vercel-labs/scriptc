import { expect, test } from "vitest";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { mangleClassStruct } from "../mangle.js";

const loc = { file: "thread-slots.ts", start: 0, end: 1 };
const slotsType: IrType = { kind: "object", className: "%ThreadSlots" };
const node: IrType = { kind: "object", className: "Node" };
const leaf: IrType = { kind: "object", className: "Leaf" };
const plain: IrType = { kind: "object", className: "Plain" };
const state: IrType = { kind: "object", className: "State" };
const maybeState: IrType = { kind: "union", unionId: "u0" };

/** A key hierarchy (Node, Leaf), a class that is not a key (Plain), and the
 * value class (State), with `slots` a module global of the slots class. */
function module(body: IrExpr[]): IrModule {
  const cls = (name: string, fields: [string, IrType][], base?: string) => ({
    name,
    ...(base !== undefined ? { base } : {}),
    fields: fields.map(([field, type]) => ({ name: field, type })),
    methods: [],
    loc,
  });
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    threadSlotKeys: ["Node"],
    globals: [
      ["slots", slotsType],
      ["node", node],
      ["leaf", leaf],
      ["plain", plain],
      ["state", state],
    ].map(([name, type]) => ({ id: `%g.${name as string}`, name, type, mutable: false })),
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: body.map((expr) => ({ kind: "exprStmt" as const, expr, loc })),
        loc,
      },
    ],
    classes: [
      cls("%ThreadSlots", []),
      cls("Node", [["name", STRING]]),
      cls(
        "Leaf",
        [
          ["name", STRING],
          ["weight", F64],
        ],
        "Node",
      ),
      cls("Plain", [["name", STRING]]),
      cls("State", [["count", F64]]),
    ],
    unions: [{ id: "u0", arms: [state, { kind: "undefinedT" }] }],
  } as unknown as IrModule;
}

function body(llvm: string, name: string): string {
  const start = llvm.indexOf(`@${name}(`);
  return start < 0 ? "" : llvm.slice(start, llvm.indexOf("\n}", start));
}

const intrinsic = (name: string, args: IrExpr[], type: IrType): IrExpr =>
  ({ kind: "intrinsic", name, args, type, loc }) as IrExpr;
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const global = (id: string, type: IrType): IrExpr =>
  ({ kind: "varRef", localId: `%g.${id}`, type, loc }) as IrExpr;
const slots = global("slots", slotsType);
const fresh = (type: IrType & { kind: "object" }): IrExpr =>
  global(type.className.toLowerCase(), type);

test("slots.get reads the slot word, the page and the entry inline", () => {
  const calls = [
    intrinsic("slots.get", [str("s"), slots, fresh(leaf)], maybeState),
    intrinsic("slots.has", [str("s"), slots, fresh(node)], BOOL),
    intrinsic("slots.set", [str("s"), slots, fresh(leaf), fresh(state)], VOID),
    intrinsic("slots.delete", [str("t"), slots, fresh(node)], BOOL),
  ];
  expect(validateModule(module(calls))).toEqual([]);
  const llvm = emitLlvmModule(module(calls), { pointerBits: 64 });
  // The slot word sits after the rc word of every hierarchy member, which
  // keeps its class id in the rc word instead of a vtable word.
  expect(llvm).toMatch(new RegExp(`%${mangleClassStruct("Node")} = type \\{ i64, i32, ptr \\}`));
  expect(llvm).toMatch(
    new RegExp(`%${mangleClassStruct("Leaf")} = type \\{ i64, i32, ptr, (i32|double) \\}`),
  );
  expect(llvm).toMatch(new RegExp(`%${mangleClassStruct("Plain")} = type \\{ i64, ptr \\}`));
  // One block per family name.
  expect(llvm).toMatch(
    /@sc_slots_0 = internal global \{ ptr, i32, i32, ptr, ptr \} zeroinitializer/,
  );
  expect(llvm).toMatch(
    /@sc_slots_1 = internal global \{ ptr, i32, i32, ptr, ptr \} zeroinitializer/,
  );
  const main = body(llvm, "sc_f_main");
  expect(main).toMatch(
    /getelementptr inbounds %\S+, ptr %\S+, i64 0, i32 1\n {2}(%\S+) = load atomic i32, ptr %\S+ monotonic, align 4\n {2}%\S+ = lshr i32 \1, 10/,
  );
  expect(main).not.toMatch(/call ptr @scr_slots_get/);
  expect(main).toMatch(
    /call void @scr_slots_set\(ptr @sc_slots_0, ptr %\S+, ptr %\S+, ptr %\S+, ptr @\S+\)/,
  );
  expect(main).toMatch(/call zeroext i1 @scr_slots_delete\(ptr @sc_slots_1, ptr %\S+\)/);
});

test("freeing a key releases its values when its slot word is set", () => {
  const llvm = emitLlvmModule(
    module([intrinsic("slots.has", [str("s"), slots, fresh(node)], BOOL)]),
    { pointerBits: 64 },
  );
  expect(llvm).toMatch(/icmp ne i32 %tdw, 0\n {2}br i1 %tdw\.set, label %tdw\.forget/);
  expect(llvm).toMatch(/call void @scr_slots_forget\(i32 %tdw\)/);
});

test("the validator checks ThreadSlots intrinsic operands", () => {
  const bad = [
    intrinsic("slots.get", [str("s"), slots], maybeState),
    intrinsic("slots.has", [slots, slots, fresh(node)], BOOL),
    intrinsic("slots.has", [str("s"), slots, fresh(plain)], BOOL),
    intrinsic(
      "slots.set",
      [str("s"), slots, fresh(node), { kind: "numLit", value: 1, type: F64, loc }],
      VOID,
    ),
    intrinsic("slots.get", [str("s"), slots, fresh(node)], state),
  ];
  expect(validateModule(module(bad)).map((e) => e.message)).toEqual([
    "in main: slots.get takes 3 arguments",
    "in main: slots.has takes a name literal and a %ThreadSlots value",
    "in main: slots.has key object:Plain is not a ThreadSlots key class",
    "in main: slots.set value f64 is not a ThreadSlots value type",
    "in main: slots.get has a V | undefined union type",
  ]);
});
