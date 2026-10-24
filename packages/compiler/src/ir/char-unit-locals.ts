import {
  BOOL,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { mapExprChildren, mapStmtChildren } from "./traverse.js";

type CharAt = IrExpr & { kind: "strIntrinsic" };
type UnitUse = IrExpr & { kind: "strEq" | "strCmp" };

const FLIPPED = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as const;

/** Character locals held as their code unit.
 *
 * `const c = s[i]` (or `s.charAt(i)`) followed only by tests such as
 * `c === " "`, `c >= "a" && c <= "z"` or `switch (c) { case "x": ... }`
 * against literals of one UTF-16 code unit builds a one-character string
 * and compares strings, though every answer follows from the code unit.
 * Such a local holds `s.charCodeAt(i)` instead, and each test compares
 * numbers:
 * - a one-unit string compares as its unit;
 * - charAt reads "" for an index out of range, and charCodeAt reads NaN.
 *   "" equals no one-unit literal and is below each, while NaN equals no
 *   unit and fails every ordered comparison, so `c < "x"` becomes
 *   `!(c >= 120)`.
 *
 * Only immutable unboxed string locals qualify, with one declaration whose
 * initializer is a one-argument charAt, and with no other mention of the
 * local. The same tests of `s.charAt(i)` in place compare
 * `s.charCodeAt(i)`, so a loop version sees one kind of read. */
export function holdCharLocalsAsUnits(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const next = rewriteFunction(fn);
    if (next !== fn) changed = true;
    return next;
  });
  return changed ? { ...mod, functions } : mod;
}

function rewriteFunction(fn: IrFunction): IrFunction {
  const candidates = new Set(
    fn.locals.filter((l) => !l.mutable && !l.boxed && l.type.kind === "string").map((l) => l.id),
  );
  // Every mention of a candidate, in any field, against the mentions the
  // rewrite understands.
  const mentions = new Map<string, number>();
  const understood = new Map<string, number>();
  const declarations = new Map<string, number>();
  const note = (map: Map<string, number>, id: string): void => {
    map.set(id, (map.get(id) ?? 0) + 1);
  };
  const count = (value: unknown): void => {
    if (typeof value === "string") {
      if (candidates.has(value)) note(mentions, value);
    } else if (Array.isArray(value)) {
      for (const item of value) count(item);
    } else if (value !== null && typeof value === "object") {
      const node = value as Record<string, unknown>;
      const id = understoodMention(node);
      if (id !== null && candidates.has(id)) {
        note(understood, id);
        if (node.kind === "varDecl") note(declarations, id);
      }
      for (const key in node) if (key !== "loc") count(node[key]);
    }
  };
  if (candidates.size > 0) count(fn.body);
  const held = new Set<string>();
  for (const id of candidates)
    if (
      declarations.get(id) === 1 &&
      (mentions.get(id) ?? 0) > 0 &&
      mentions.get(id) === understood.get(id)
    )
      held.add(id);
  let changed = false;

  const unitRef = (id: string, loc: IrExpr["loc"]): IrExpr => ({
    kind: "varRef",
    localId: id,
    type: F64,
    loc,
  });
  const rewriteExpr = (e: IrExpr): IrExpr => {
    if (e.kind === "strEq" || e.kind === "strCmp") {
      const use = unitUse(e);
      if (use && held.has(use.id)) {
        changed = true;
        return charUnitTest(e, unitRef(use.id, e.loc), use.code, use.left);
      }
      // `s.charAt(i)` in place: its unit read, `s.charCodeAt(i)`.
      const direct = charAtTest(e);
      if (direct) {
        changed = true;
        const read: IrExpr = {
          ...direct.charAt,
          method: "charCodeAt",
          receiver: rewriteExpr(direct.charAt.receiver),
          args: direct.charAt.args.map(rewriteExpr),
          type: F64,
        };
        return charUnitTest(e, read, direct.code, direct.left);
      }
    }
    return mapExprChildren(e, rewriteExpr, rewriteStmt);
  };
  const rewriteStmt = (s: IrStmt): IrStmt => {
    if (s.kind === "varDecl" && held.has(s.localId) && s.init?.kind === "strIntrinsic") {
      changed = true;
      return {
        ...s,
        init: {
          ...s.init,
          method: "charCodeAt",
          receiver: rewriteExpr(s.init.receiver),
          args: s.init.args.map(rewriteExpr),
          type: F64,
        },
      };
    }
    if (s.kind === "switch" && s.disc.kind === "varRef" && held.has(s.disc.localId)) {
      changed = true;
      return {
        ...s,
        disc: unitRef(s.disc.localId, s.disc.loc),
        cases: s.cases.map((c) => ({
          ...c,
          test:
            c.test?.kind === "strLit"
              ? { kind: "numLit", value: c.test.value.charCodeAt(0), type: F64, loc: c.test.loc }
              : c.test,
          body: c.body.map(rewriteStmt),
        })),
      };
    }
    return mapStmtChildren(s, rewriteExpr, rewriteStmt);
  };
  const body = fn.body.map(rewriteStmt);
  if (!changed) return fn;
  return {
    ...fn,
    body,
    locals: fn.locals.map((l) => (held.has(l.id) ? unitLocal(l) : l)),
  };
}

/** The local, holding the code unit instead of the one-character string. */
function unitLocal(local: IrLocal): IrLocal {
  return { ...local, type: F64 };
}

/** The local a node mentions in a form the rewrite handles: the
 * declaration from a one-argument charAt, a one-unit test, or a switch
 * over one-unit cases. */
function understoodMention(node: Record<string, unknown>): string | null {
  // count() visits every object in the body (types, locations, cases), so
  // only the node kinds handled here are read as IR nodes
  const kind = node.kind;
  if (kind !== "varDecl" && kind !== "strEq" && kind !== "strCmp" && kind !== "switch") return null;
  const n = node as unknown as IrExpr | IrStmt;
  if (n.kind === "varDecl") return n.init && isCharAt(n.init) ? n.localId : null;
  if (n.kind === "strEq" || n.kind === "strCmp") return unitUse(n)?.id ?? null;
  if (n.kind === "switch") {
    if (n.disc.kind !== "varRef") return null;
    if (!n.cases.some((c) => c.test !== null)) return null;
    const units = n.cases.every(
      (c) => c.test === null || (c.test.kind === "strLit" && c.test.value.length === 1),
    );
    return units ? n.disc.localId : null;
  }
  return null;
}

/** A one-unit test of a string that reads one character or "" (charAt),
 * on its unit `unit`, which reads NaN for "": an equality, or an ordered
 * comparison with the unit on the left when `unitLeft`. "" is below every
 * one-unit literal, and NaN fails every ordered comparison, so `c < "x"`
 * becomes `!(c >= 120)`. */
function charUnitTest(e: UnitUse, unit: IrExpr, code: number, unitLeft: boolean): IrExpr {
  const literal: IrExpr = { kind: "numLit", value: code, type: F64, loc: e.loc };
  if (e.kind === "strEq")
    return {
      kind: "bin",
      op: e.negated ? "!==" : "===",
      left: unit,
      right: literal,
      type: BOOL,
      loc: e.loc,
    };
  const op = unitLeft ? e.op : FLIPPED[e.op];
  if (op === ">" || op === ">=")
    return { kind: "bin", op, left: unit, right: literal, type: BOOL, loc: e.loc };
  const negation: IrExpr = {
    kind: "bin",
    op: op === "<" ? ">=" : ">",
    left: unit,
    right: literal,
    type: BOOL,
    loc: e.loc,
  };
  return { kind: "unary", op: "!", operand: negation, type: BOOL, loc: e.loc };
}

/** A test between `s.charAt(i)` and a literal of one code unit. */
function charAtTest(e: UnitUse): { charAt: CharAt; code: number; left: boolean } | null {
  const literalRight = e.right.kind === "strLit";
  const literal = literalRight ? e.right : e.left;
  const other = literalRight ? e.left : e.right;
  if (literal.kind !== "strLit" || literal.value.length !== 1 || !isCharAt(other)) return null;
  return { charAt: other, code: literal.value.charCodeAt(0), left: literalRight };
}

function isCharAt(e: IrExpr): e is CharAt {
  return e.kind === "strIntrinsic" && e.method === "charAt" && e.args.length === 1;
}

/** A test between a local and a literal of one code unit. */
function unitUse(e: UnitUse): { id: string; code: number; left: boolean } | null {
  const literalRight = e.right.kind === "strLit";
  const literal = literalRight ? e.right : e.left;
  const other = literalRight ? e.left : e.right;
  if (literal.kind !== "strLit" || literal.value.length !== 1 || other.kind !== "varRef")
    return null;
  return { id: other.localId, code: literal.value.charCodeAt(0), left: literalRight };
}
