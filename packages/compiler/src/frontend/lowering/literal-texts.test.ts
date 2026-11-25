import { expect, test } from "vitest";
import { STRING, VOID, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { LiteralTexts } from "./literal-texts.js";

const loc = { file: "texts.ts", start: 0, end: 1 };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  params: [],
  returnType: VOID,
  locals: [],
  body,
  loc,
});
const throwing = (message: IrExpr): IrStmt => ({
  kind: "throw",
  value: {
    kind: "libCall",
    fn: "error.new",
    args: [message],
    type: { kind: "object", className: "%TypeError" },
    loc,
  },
  loc,
});

/** A string literal that records every string assigned to its value. */
function literal(value: string): { node: IrExpr; assigned: string[] } {
  const assigned: string[] = [];
  let current = value;
  const node = { kind: "strLit", type: STRING, loc } as IrExpr & { value: string };
  Object.defineProperty(node, "value", {
    enumerable: true,
    get: () => current,
    set: (next: string) => {
      assigned.push(next);
      current = next;
    },
  });
  return { node, assigned };
}

const text = (suffix: string): string =>
  ["expected { kind: 'a'; value: number } | { kind: 'b'; items: string[] }", suffix].join(" ");

test("the long string literals of finished functions share one string per text", () => {
  const texts = new LiteralTexts();
  const first = literal(text("(a null value has no arm)"));
  const repeat = literal(text("(a null value has no arm)"));
  const other = literal(text("(an undefined value has no arm)"));
  const short = literal("then");
  const shortRepeat = literal("then");
  texts.intern(fn("a", [throwing(first.node), throwing(short.node)]));
  texts.intern(fn("b", [throwing(repeat.node), throwing(other.node), throwing(shortRepeat.node)]));
  // The first literal of a text is the one string of that text, and a repeat takes it.
  expect(first.assigned).toEqual([]);
  expect(repeat.assigned).toEqual([text("(a null value has no arm)")]);
  expect(other.assigned).toEqual([]);
  // Short literals are left alone, and no text changes.
  expect(short.assigned).toEqual([]);
  expect(shortRepeat.assigned).toEqual([]);
  expect(repeat.node).toMatchObject({ kind: "strLit", value: text("(a null value has no arm)") });
});

test("functions appended to a list are interned once, from where the last call stopped", () => {
  const texts = new LiteralTexts();
  const lifted: IrFunction[] = [];
  const first = literal(text("(first)"));
  const second = literal(text("(first)"));
  const third = literal(text("(first)"));
  lifted.push(fn("%lambda.0", [throwing(first.node)]));
  texts.internAdded(lifted);
  texts.internAdded(lifted);
  lifted.push(fn("%lambda.1", [throwing(second.node)]), fn("%lambda.2", [throwing(third.node)]));
  texts.internAdded(lifted);
  texts.internAdded(lifted);
  expect(first.assigned).toEqual([]);
  expect(second.assigned).toHaveLength(1);
  expect(third.assigned).toHaveLength(1);
});
