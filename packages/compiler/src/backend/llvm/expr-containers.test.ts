import { expect, test } from "vitest";
import {
  DATE_T,
  F64,
  VOID,
  arrayOf,
  typeKey,
  type IrArrIntrinsicMethod,
  type IrExpr,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { emitLlvmModule, type LlvmTargetOptions } from "./emitter.js";

const loc = { file: "array-mutation.ts", start: 0, end: 0 };
type Guard = "none" | "frozen" | "published" | "both";

function module(method: IrArrIntrinsicMethod, guard: Guard, elem: IrType = F64): IrModule {
  const arr = arrayOf(elem);
  const receiver = (): IrExpr => ({ kind: "varRef", localId: "a", type: arr, loc });
  const count =
    method === "copyWithin" || method === "fill" ? 3 : method === "fillUndefined" ? 2 : 0;
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    ...(guard === "frozen" || guard === "both" ? { freezableArrays: [typeKey(arr)] } : {}),
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      ...(guard === "published" || guard === "both"
        ? [
            {
              name: "share",
              params: [{ name: "a", localId: "a", type: arr }],
              returnType: arr,
              locals: [{ id: "a", name: "a", type: arr, mutable: false }],
              body: [
                {
                  kind: "return" as const,
                  value: {
                    kind: "intrinsic" as const,
                    name: "threads.publish" as const,
                    args: [receiver()],
                    type: arr,
                    loc,
                  },
                  loc,
                },
              ],
              loc,
            },
          ]
        : []),
      {
        name: "mutate",
        params: [{ name: "a", localId: "a", type: arr }],
        returnType: arr,
        locals: [{ id: "a", name: "a", type: arr, mutable: false }],
        body: [
          {
            kind: "return",
            value: {
              kind: "arrIntrinsic",
              method,
              receiver: receiver(),
              args: Array.from({ length: count }, (_, value): IrExpr => ({
                kind: "numLit",
                value,
                type: F64,
                loc,
              })),
              type: arr,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

function blocks(
  method: IrArrIntrinsicMethod,
  guard: Guard,
  pointerBits: 32 | 64,
  elem: IrType = F64,
  options: LlvmTargetOptions = {},
): Map<string, string> {
  return emittedBlocks(module(method, guard, elem), { pointerBits, ...options });
}

function emittedBlocks(mod: IrModule, options: LlvmTargetOptions): Map<string, string> {
  const llvm = emitLlvmModule(mod, options);
  const fn = Array.from(
    llvm.matchAll(/^define [^\n]*@sc_(?:f|bf)_mutate(?:\.i32)?\([^]*?^}/gm),
    (m) => m[0],
  ).find((body) =>
    /@scr_(?:throw_published_array|arr_(?:reverse|sort_primitive|sort_by_text|copy_within|fill_))/.test(
      body,
    ),
  );
  expect(fn).toBeDefined();
  return new Map(
    Array.from(fn!.matchAll(/^([\w.]+):\n([^]*?)(?=^[\w.]+:|^})/gm), (m) => [m[1]!, m[2]!]),
  );
}

const successors = (body: string): string[] =>
  Array.from(body.matchAll(/\blabel %([\w.]+)/g), (m) => m[1]!);

function returnedReceiver(graph: Map<string, string>, noop: string): void {
  const body = graph.get(noop)!;
  const retained = /(%\w+) = call ptr @scr_arr_retain_v\(ptr (%\w+)\)/.exec(body);
  expect(retained).not.toBeNull();
  const check = [...graph.values()].find((block) => block.includes("@scr_throw_published_array"))!;
  const receiver = /@scr_throw_published_array(?:_range)?\(i32 \d+, ptr (%\w+)/.exec(check);
  expect(receiver).not.toBeNull();
  expect(retained![2]).toBe(receiver![1]);
  const after = reachable(graph, noop);
  const phi = /(%\w+) = phi ptr \[ [^\]]+ \], \[ (%\w+), %([\w.]+) \]/.exec(after);
  expect(phi).not.toBeNull();
  expect(phi![2]).toBe(retained![1]);
  expect(phi![3]).toBe(noop);
  expect(after).toContain(`ret ptr ${phi![1]}`);
}

function reachable(graph: Map<string, string>, start: string): string {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const label = pending.pop()!;
    if (visited.has(label)) continue;
    const body = graph.get(label);
    expect(body).toBeDefined();
    visited.add(label);
    pending.push(...successors(body!));
  }
  return Array.from(visited, (label) => graph.get(label)!).join("\n");
}

const cases = [
  ["reverse", "scr_arr_reverse"],
  ["copyWithin", "scr_arr_copy_within"],
  ["sortPrimitive", "scr_arr_sort_primitive"],
  ["fill", "scr_arr_fill_f64"],
  ["fillUndefined", "scr_arr_fill_undefined"],
] as const;

for (const pointerBits of [32, 64] as const) {
  for (const guard of ["frozen", "published", "both"] as const) {
    test.each(cases)(
      `%s skips all storage writes for an allowed ${guard} no-op (${pointerBits}-bit)`,
      (method, helper) => {
        const graph = blocks(method, guard, pointerBits);
        const checked = [...graph].filter(([, body]) =>
          body.includes("@scr_throw_published_array"),
        );
        expect(checked).toHaveLength(1);
        const [checkLabel, check] = checked[0]!;
        const [throws, noop] = successors(check);
        expect(throws).toBeDefined();
        expect(noop).toBeDefined();

        // Follow the guard's false edge, not the order of emitted blocks:
        // both the helper and the no-op converge on the result's join block.
        const allowed = reachable(graph, noop!);
        expect(allowed).not.toMatch(
          /@scr_arr_(?:reverse|copy_within|sort_primitive|fill_\w+|widen_\w+)\(/,
        );
        returnedReceiver(graph, noop!);
        expect(reachable(graph, throws!)).not.toContain(`@${helper}(`);

        const decision = [...graph.values()].find((body) => successors(body).includes(checkLabel));
        expect(decision).toBeDefined();
        const mutable = successors(decision!).find((label) => label !== checkLabel);
        expect(mutable).toBeDefined();
        expect(reachable(graph, mutable!)).toContain(`@${helper}(`);
      },
    );
  }

  test.each(cases)(`%s keeps the unguarded mutable path (${pointerBits}-bit)`, (method, helper) => {
    const body = [...blocks(method, "none", pointerBits).values()].join("\n");
    expect(body).not.toContain("@scr_throw_published_array");
    expect(body).toContain(`@${helper}(`);
  });

  test(`toSorted copies a frozen or published receiver (${pointerBits}-bit)`, () => {
    const body = [...blocks("toSortedPrimitive", "both", pointerBits).values()].join("\n");
    expect(body).not.toContain("@scr_throw_published_array");
    expect(body).toContain("@scr_arr_sort_primitive(");
    expect(body).toMatch(/@scr_arr_sort_primitive\(ptr [^,]+, i1 1\)/);
  });

  test(`Date sort skips text conversion on immutable no-ops (${pointerBits}-bit)`, () => {
    const graph = blocks("sortPrimitive", "both", pointerBits, DATE_T);
    const check = [...graph.values()].find((body) => body.includes("@scr_throw_published_array"))!;
    const noop = successors(check)[1]!;
    returnedReceiver(graph, noop);
    expect(reachable(graph, noop)).not.toContain("@scr_arr_sort_by_text(");
    expect([...graph.values()].join("\n")).toContain("@scr_arr_sort_by_text(");
  });
}

test.each(cases)("%s preserves the Linux unwind path", (method, helper) => {
  const graph = blocks(method, "both", 64, F64, {
    targetTriple: "x86_64-unknown-linux-gnu",
    unwindAbi: true,
  });
  const check = [...graph.values()].find((body) => body.includes("@scr_throw_published_array"))!;
  const [throws, noop] = successors(check);
  const failure = reachable(graph, throws!);
  expect(failure).toContain("call void @scr_unwind_raise()");
  expect(failure).toContain("unreachable");
  expect(failure).not.toContain(`@${helper}(`);
  expect(reachable(graph, noop!)).not.toContain(`@${helper}(`);
  returnedReceiver(graph, noop!);
});

test("an immutable empty fill bypasses checked int32 storage widening", () => {
  const mod = module("fill", "frozen");
  const arr = arrayOf(F64);
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: arr, loc });
  // A fresh fill with an exact integer outside int32 selects checked
  // storage. The empty range must still bypass its widening branch.
  mod.functions[1] = {
    name: "mutate",
    params: [],
    returnType: F64,
    loc,
    locals: ["tmp", "a"].map((id) => ({ id, name: id, type: arr, mutable: false })),
    body: [
      {
        kind: "varDecl",
        localId: "a",
        loc,
        init: {
          kind: "arrIntrinsic",
          method: "fill",
          type: arr,
          loc,
          receiver: {
            kind: "seqExpr",
            type: arr,
            loc,
            stmts: [
              {
                kind: "varDecl",
                localId: "tmp",
                loc,
                init: { kind: "arrayLit", elems: [], type: arr, loc },
              },
              { kind: "arraySetLength", arr: ref("tmp"), length: num(4096), loc },
            ],
            result: ref("tmp"),
          },
          args: [num(4294967296), num(0), num(0)],
        },
      },
      {
        kind: "return",
        loc,
        value: {
          kind: "arrIntrinsic",
          method: "length",
          receiver: ref("a"),
          args: [],
          type: F64,
          loc,
        },
      },
    ],
  };
  const graph = emittedBlocks(mod, { pointerBits: 64 });
  const [label, check] = [...graph].find(([, body]) =>
    body.includes("@scr_throw_published_array(i32 8,"),
  )!;
  const noop = successors(check)[1]!;
  const decision = [...graph.values()].find((body) => successors(body).includes(label))!;
  const mutable = successors(decision).find((target) => target !== label)!;
  for (const helper of ["scr_arr_widen_i32", "scr_arr_fill_f64"]) {
    expect(reachable(graph, mutable)).toContain(`@${helper}(`);
    expect(reachable(graph, noop)).not.toContain(`@${helper}(`);
  }
});
