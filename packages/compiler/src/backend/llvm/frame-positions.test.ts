import { expect, test } from "vitest";
import type { IrExpr, IrStmt, SrcLoc } from "../../ir/ir.js";
import { SourceLocations } from "../source-locations.js";
import {
  abortFramesDefinition,
  FramePositions,
  frameText,
  memberFrameName,
  positionedFrameText,
} from "./frame-positions.js";

const file = "/work/app.ts";
const source = [
  "function total(items: number[]): number {", // line 1
  "  let sum = 0;", // line 2
  "  while (more()) {", // line 3
  "    if (skip()) continue;", // line 4
  "    sum += next();", // line 5
  "  }", // line 6
  "  return sum;", // line 7
  "}", // line 8
].join("\n");
const sources = new SourceLocations(new Map([[file, source]]));

function at(text: string): SrcLoc {
  const start = source.indexOf(text);
  return { file, start, end: start + text.length };
}
const unit = (loc: SrcLoc): IrExpr => ({ kind: "unitLit", type: { kind: "void" }, loc }) as IrExpr;
function exprStmt(text: string): IrStmt {
  return { kind: "exprStmt", expr: unit(at(text)), loc: at(text) };
}

/** Walks `body` as the emitter does and returns the stored frame lines.
 * `embedded` gives the statements an expression of a statement embeds,
 * which the emitter reaches before the statement's body. */
function stores(
  sourceName: string | undefined,
  body: IrStmt[],
  embedded: ReadonlyMap<IrStmt, IrStmt[]> = new Map(),
): string[] {
  const out: string[] = [];
  const positions = new FramePositions(
    sourceName,
    (loc) => sources.position(loc),
    (text) => out.push(text),
  );
  const children = (s: IrStmt): IrStmt[] =>
    s.kind === "while" || s.kind === "block"
      ? s.body
      : s.kind === "if"
        ? [...s.then, ...(s.else_ ?? [])]
        : [];
  const walk = (s: IrStmt): void => {
    const restore = positions.enter(s);
    if (s.kind === "continue") positions.continueLoop(s.label);
    for (const child of embedded.get(s) ?? []) walk(child);
    for (const child of children(s)) walk(child);
    positions.leave(restore, s.kind !== "continue" && s.kind !== "return");
  };
  for (const s of body) walk(s);
  return out;
}

test("a frame line names the function, the file, and the statement's line and column", () => {
  expect(frameText("total", file)).toBe("    at total (/work/app.ts)");
  expect(positionedFrameText("total", { file, line: 5, column: 5 })).toBe(
    "    at total (/work/app.ts:5:5)",
  );
  expect(positionedFrameText("<anonymous>", { file, line: 5, column: 5 })).toBe(
    "    at <anonymous> (/work/app.ts:5:5)",
  );
  // Module-level code prints the bare position, as Node does for a module.
  expect(positionedFrameText(undefined, { file, line: 1, column: 1 })).toBe(
    "    at /work/app.ts:1:1",
  );
});

test("class members are named as V8 names them", () => {
  expect(memberFrameName("Shape", "constructor")).toBe("new Shape");
  expect(memberFrameName("Shape", "area")).toBe("Shape.area");
  expect(memberFrameName("Shape", "#scale")).toBe("Shape.#scale");
  expect(memberFrameName("Shape", "get:sides")).toBe("Shape.get sides");
  expect(memberFrameName("Shape", "set:sides")).toBe("Shape.set sides");
  expect(memberFrameName("Shape", "static:make")).toBe("Shape.make");
  expect(memberFrameName("Shape", "static:get:count")).toBe("Shape.get count");
  // A generic instantiation's digest is not part of the name.
  expect(memberFrameName("Box", "map%57d9d389d7a0")).toBe("Box.map");
  expect(memberFrameName("Box", "static:make%5c48710dd3b0")).toBe("Box.make");
  expect(memberFrameName("", "run")).toBe("<anonymous>.run");
});

test("each statement stores its position, and a loop takes its own back", () => {
  const loop: IrStmt = {
    kind: "while",
    cond: unit(at("more()")),
    body: [
      {
        kind: "if",
        cond: unit(at("skip()")),
        then: [{ kind: "continue", loc: at("continue;") }],
        else_: null,
        loc: at("if (skip())"),
      },
      exprStmt("sum += next();"),
    ],
    loc: at("while (more())"),
  };
  expect(
    stores("total", [exprStmt("let sum = 0;"), loop, exprStmt("return sum;")]).map((line) =>
      line.slice("    at total (/work/app.ts:".length, -1),
    ),
  ).toEqual([
    "2:3", // let sum = 0;
    "3:3", // the loop, before its first condition
    "4:5", // if (skip())
    "3:3", // continue: the loop's condition runs next
    "3:3", // the if finished inside the loop
    "5:5", // sum += next();
    "3:3", // the body finished: the condition runs again
    "7:3", // return sum;
  ]);
});

test("a block stores nothing, and a container does not take its position back", () => {
  const branch: IrStmt = {
    kind: "if",
    cond: unit(at("skip()")),
    then: [{ kind: "block", body: [exprStmt("sum += next();")], loc: at("while (more())") }],
    else_: null,
    loc: at("if (skip())"),
  };
  expect(stores(undefined, [branch, exprStmt("return sum;")])).toEqual([
    "    at /work/app.ts:4:5",
    "    at /work/app.ts:5:5",
    "    at /work/app.ts:7:3",
  ]);
});

test("a container takes its position back after a statement embedded in its head", () => {
  // `if ((skip(), more())) { sum += next(); }`: the comma's left operand is
  // a statement inside the condition, and the rest of the condition runs
  // after it.
  const left = exprStmt("skip()");
  const branch: IrStmt = {
    kind: "if",
    cond: unit(at("more()")),
    then: [exprStmt("sum += next();")],
    else_: null,
    loc: at("while (more())"),
  };
  expect(
    stores("total", [branch, exprStmt("return sum;")], new Map([[branch, [left]]])).map((line) =>
      line.slice("    at total (/work/app.ts:".length, -1),
    ),
  ).toEqual([
    "3:3", // the if
    "4:9", // skip(), embedded in the condition
    "3:3", // the rest of the condition
    "5:5", // sum += next(); in the body: nothing of the if runs after it
    "7:3", // return sum;
  ]);
});

test("a statement the sources do not hold keeps the position before it", () => {
  const foreign: IrStmt = {
    kind: "exprStmt",
    expr: unit({ file: "/elsewhere/helper.ts", start: 4, end: 9 }),
    loc: { file: "/elsewhere/helper.ts", start: 4, end: 9 },
  };
  const synthetic: IrStmt = { ...exprStmt("return sum;"), loc: { file, start: -1, end: -1 } };
  expect(stores("total", [exprStmt("let sum = 0;"), foreign, synthetic])).toEqual([
    "    at total (/work/app.ts:2:3)",
  ]);
});

test("the abort report walks at most ten frames of the chain and only writes", () => {
  const text = abortFramesDefinition("nounwind").join("\n");
  expect(text).toContain("define internal void @sc_abort_frames(i32 %signal) nounwind {");
  expect(text).toContain("%full = icmp eq i32 %count, 10");
  expect(text.match(/call [^@]*@(\w+)/g)?.map((call) => call.replace(/.*@/, ""))).toEqual([
    "scr_exc_current_cell",
    "strlen",
    "write",
    "write",
  ]);
});
