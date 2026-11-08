import { expect, test } from "vitest";
import { DYN, STRING, VOID, type IrModule, type IrType } from "../../ir/ir.js";
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
