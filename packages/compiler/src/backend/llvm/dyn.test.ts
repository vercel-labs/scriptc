import { expect, test } from "vitest";
import {
  DYN,
  NULL_T,
  STRING,
  VOID,
  typeKey,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

/** `look(value, key)` boxed as a function value: the box's call thunk
 * converts the second argument to a string and calls the function. */
function boxedFunction(): IrModule {
  const loc = { file: "boxed-function.ts", start: 0, end: 0 };
  const look: IrType = { kind: "func", params: [DYN, STRING], ret: DYN };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        loc,
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "dynFrom",
              value: { kind: "closure", fnName: "look", captures: [], type: look, loc },
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      },
      {
        name: "look",
        params: [
          { localId: "value", name: "value", type: DYN },
          { localId: "key", name: "key", type: STRING },
        ],
        returnType: DYN,
        locals: [
          { id: "value", name: "value", type: DYN, mutable: false },
          { id: "key", name: "key", type: STRING, mutable: false },
        ],
        loc,
        body: [
          { kind: "return", value: { kind: "varRef", localId: "value", type: DYN, loc }, loc },
        ],
      },
    ],
  };
}

/** The call thunk of `look`'s function type: the value its conversion made,
 * the value its call returned, and its blocks by label. */
function callThunk(llvm: string): {
  converted: string;
  returned: string;
  blocks: Map<string, string>;
} {
  const body = /^define internal ptr @sc_dfk_0\(.*?\n}/ms.exec(llvm)?.[0];
  if (body === undefined) throw new Error("no call thunk");
  const converted = /^ {2}(%\w+) = call ptr @sc_dc_\d+\(/m.exec(body)?.[1];
  const returned = /^ {2}(%\w+) = call ptr %\w+\(ptr %c, /m.exec(body)?.[1];
  if (converted === undefined || returned === undefined) throw new Error(body);
  const blocks = new Map<string, string>();
  let label = "";
  for (const line of body.split("\n")) {
    const start = /^([\w.]+):$/.exec(line);
    if (start) label = start[1]!;
    else blocks.set(label, `${blocks.get(label) ?? ""}${line}\n`);
  }
  return { converted, returned, blocks };
}

/** The block a pending test branches to when it is true (`<hint>.u<n>`). */
function bail(blocks: Map<string, string>, hint: string): string {
  const found = [...blocks].filter(([label]) => new RegExp(`^${hint}\\.u\\d+$`).test(label));
  if (found.length !== 1) throw new Error(`${hint}: ${found.length} bail blocks`);
  return found[0]![1];
}

test("a worker program's call thunk releases what it converted and what the call returned when it gives up", () => {
  // The pending test of a worker program is also true once its thread must
  // stop, after a conversion or a call that succeeded.
  const workers = callThunk(emitLlvmModule({ ...boxedFunction(), workers: true }));
  expect(bail(workers.blocks, "dfk")).toMatch(
    new RegExp(
      `call void @\\w*release\\w*\\(ptr ${workers.converted}\\)\\n(.*\\n)* {2}ret ptr null`,
    ),
  );
  expect(bail(workers.blocks, "dfkr")).toMatch(
    new RegExp(`call void @\\w*release\\w*\\(ptr ${workers.returned}\\)\\n {2}ret ptr null`),
  );
  // Elsewhere the test is exactly "an exception is pending": the conversion
  // or the call threw and returned null, and the blocks stay as they were.
  const plain = callThunk(emitLlvmModule(boxedFunction()));
  expect(bail(plain.blocks, "dfk")).not.toContain(`(ptr ${plain.converted})`);
  expect(bail(plain.blocks, "dfkr")).toBe("  ret ptr null\n");
});

/** `Root` with the subclasses `Sub` (and `Tip` below it) and `Side`, and a
 * conversion of an untyped value to each of `targets`. */
function classConversions(targets: readonly IrType[]): IrModule {
  const loc = { file: "class-conversions.ts", start: 0, end: 0 };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    classes: [
      { name: "Root", fields: [], methods: [], loc },
      { name: "Sub", base: "Root", fields: [], methods: [], loc },
      { name: "Tip", base: "Sub", fields: [], methods: [], loc },
      { name: "Side", base: "Root", fields: [], methods: [], loc },
      { name: "Alone", fields: [], methods: [], loc },
    ],
    unions: [{ id: "nullableSub", arms: [NULL_T, { kind: "object", className: "Sub" }] }],
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        loc,
        body: [
          {
            kind: "exprStmt",
            expr: {
              kind: "call",
              callee: "convert",
              args: [
                {
                  kind: "dynFrom",
                  value: { kind: "strLit", value: "text", type: STRING, loc },
                  type: DYN,
                  loc,
                },
              ],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
      },
      {
        name: "convert",
        params: [{ localId: "value", name: "value", type: DYN }],
        returnType: VOID,
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        loc,
        body: targets.map((type): IrStmt => ({
          kind: "exprStmt",
          expr: {
            kind: "dynCheck",
            value: { kind: "varRef", localId: "value", type: DYN, loc },
            type,
            loc,
          },
          loc,
        })),
      },
    ],
  };
}

/** The helper whose header comment is `comment`, by its blocks. */
function helperBlocks(llvm: string, comment: string): Map<string, string> {
  const start = llvm.indexOf(`{ ; ${comment}\n`);
  if (start < 0) throw new Error(`no helper: ${comment}`);
  const blocks = new Map<string, string>();
  let label = "";
  for (const line of llvm.slice(start, llvm.indexOf("\n}\n", start)).split("\n").slice(1)) {
    const next = /^([\w.]+):$/.exec(line);
    if (next) label = next[1]!;
    else blocks.set(label, `${blocks.get(label) ?? ""}${line}\n`);
  }
  return blocks;
}

/** The symbol of the type key constant of `className`. */
function classKey(llvm: string, className: string): string {
  const symbol = new RegExp(`^(@sc_cs_\\d+) = .* c"object:${className}\\\\00"$`, "m").exec(llvm);
  if (!symbol) throw new Error(`no key constant of ${className}`);
  return symbol[1]!;
}

test("a conversion to a class accepts a capsule of an ancestor that holds an instance of the class", () => {
  const sub: IrType = { kind: "object", className: "Sub" };
  const llvm = emitLlvmModule(classConversions([{ kind: "union", unionId: "nullableSub" }]));
  const keys = { root: classKey(llvm, "Root"), sub: classKey(llvm, "Sub") };
  const ownKeyTest = `@scr_dyn_typed_ref_is(ptr %d, ptr ${keys.sub},`;
  const tipKeyTest = `@scr_dyn_typed_ref_is(ptr %d, ptr ${classKey(llvm, "Tip")},`;
  const rootKeyTest = `@scr_dyn_typed_ref_is(ptr %d, ptr ${keys.root},`;
  const heldTest = "call zeroext i1 @sc_dh_Sub(ptr %d)\n";
  // The test of an ancestor's capsule, one function per class: the
  // instance's own class decides, with the interval test `instanceof Sub`
  // makes (Sub and Tip are preorder 1, 2).
  expect(llvm).toContain(
    "define internal zeroext i1 @sc_dh_Sub(ptr %d) noinline cold #0 { ; holds object:Sub\n",
  );
  const held = helperBlocks(llvm, "holds object:Sub");
  const keyed = /br i1 %t\d+, label %(dh\.is\d+), label %(dh\.key\d+)\n$/.exec(held.get("entry")!);
  expect(held.get("entry")).toContain(rootKeyTest);
  expect(keyed).not.toBeNull();
  const instance = held.get(keyed![1]!)!;
  expect(instance).toMatch(/= getelementptr inbounds i8, ptr %d, i64 16 ; ->v\n/);
  expect(instance).toMatch(
    /icmp uge i(32|64) %t\d+, 1\n {2}%t\d+ = icmp ule i(32|64) %t\d+, 2\n {2}(%t\d+) = and i1 %t\d+, %t\d+ ; a Root capsule holds a Sub\n {2}ret i1 \3\n$/,
  );
  // A capsule of no ancestor is refused.
  expect(held.get(keyed![2]!)).toBe("  ret i1 false\n");
  // The matcher, the builder and the union's capsule-first selection of the
  // arm all go on to the one test, each in the block a capsule reaches once
  // no key test accepted it, and each accepts as its own key test does.
  const helpers = [
    {
      helper: "matches object:Sub",
      reached: /^dm\.tr\.mat\d+$/,
      accepts: /^ {2}ret i1 true\n$/,
      refuses: /^ {2}ret i1 false\n$/,
    },
    {
      helper: "check object:Sub",
      reached: /^dc\.tr\.cap\d+$/,
      accepts: /^ {2}%t\d+ = call ptr @scr_dyn_typed_ref_unbox\(ptr %d\)\n {2}ret ptr %t\d+\n$/,
      refuses: /^ {2}%t\d+ = call ptr @scr_dyn_typed_ref_cached_cast\(ptr %d, /,
    },
    {
      helper: "check union:nullableSub",
      reached: /^du\.own\.n\d+$/,
      accepts: /= call ptr @sc_dc_\d+\(ptr %d, ptr %path\)\n/,
      refuses: /^ {2}br label %du\.other\d+\n$/,
    },
  ];
  for (const { helper, reached, accepts, refuses } of helpers) {
    const blocks = helperBlocks(llvm, helper);
    const text = [...blocks].map(([label, body]) => `${label}:\n${body}`).join("");
    // The class itself and its subclass first, as before.
    const own = text.indexOf(ownKeyTest);
    expect(own, helper).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(tipKeyTest), helper).toBeGreaterThan(own);
    expect(text, helper).not.toContain(rootKeyTest);
    // The ancestor's capsule is tested where only a refused capsule comes.
    const [label, asked] = [...blocks].find(([, body]) => body.includes(heldTest))!;
    expect(label, helper).toMatch(reached);
    const decided = /br i1 %t\d+, label %([\w.]+), label %([\w.]+)\n$/.exec(asked);
    expect(decided, helper).not.toBeNull();
    expect(blocks.get(decided![1]!), helper).toMatch(accepts);
    expect(blocks.get(decided![2]!), helper).toMatch(refuses);
  }
  // A sibling's capsule can hold no Sub, and a class of another hierarchy
  // neither: no test names them, so the module has no key of theirs.
  expect(llvm).not.toContain('c"object:Side\\00"');
  expect(llvm).not.toContain('c"object:Alone\\00"');
  expect(llvm).toContain(`; matches ${typeKey(sub)}\n`);
});

test("a conversion to a class without ancestors tests only the class and its subclasses", () => {
  const llvm = emitLlvmModule(
    classConversions([
      { kind: "object", className: "Root" },
      { kind: "object", className: "Alone" },
    ]),
  );
  // No capsule of another class can hold a Root or an Alone: the module has
  // no test of a held instance.
  expect(llvm).not.toContain("@sc_dh_");
  // Root's slot takes a capsule of every class below it by the capsule's key.
  const root = [...helperBlocks(llvm, "check object:Root").values()].join("");
  for (const className of ["Root", "Sub", "Tip", "Side"])
    expect(root).toContain(`@scr_dyn_typed_ref_is(ptr %d, ptr ${classKey(llvm, className)},`);
});
