/** Runtime-key reflection over a builtin module namespace (`k in zlib`,
 * `zlib.hasOwnProperty(k)` with a key only known at run time). The census
 * names are static, so the test is an interned helper — one per module,
 * flavor and question — that dispatches on the key's length first and
 * compares it against the names of that length only. Lengths are searched
 * in a balanced tree, so a miss costs a handful of numeric comparisons
 * instead of one string comparison per name. */
import { numLit, varRef } from "../../ir/build.js";
import { BOOL, F64, type IrExpr, type IrStmt, STRING, type SrcLoc } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { sideEffectFreeOptionValue } from "./surfaces.js";
import {
  builtinModuleInNames,
  builtinModuleOwnNames,
  type BuiltinModuleNamespaceFlavor,
} from "./builtin-module-members.js";
import type { Lowerer } from "./lowerer.js";
import { keyedHelperName } from "./stable-names.js";

export interface BuiltinNamespaceShape {
  readonly module: string;
  readonly flavor: BuiltinModuleNamespaceFlavor;
}

/** `key in ns` (ownOnly false) or `ns.hasOwnProperty(key)` (ownOnly true)
 * with a runtime key. Null when the module is not in the census, so the
 * caller keeps its fence. */
export function builtinNamespaceMemberTest(
  lowerer: Lowerer,
  shape: BuiltinNamespaceShape,
  ownOnly: boolean,
  key: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  const names = ownOnly
    ? builtinModuleOwnNames(shape.module, shape.flavor)
    : builtinModuleInNames(shape.module, shape.flavor);
  if (names === null) return null;
  const cacheKey = `${ownOnly ? "own" : "in"}:${shape.flavor}:${shape.module}`;
  let helper = lowerer.valueHelpers.get(cacheKey);
  if (helper === undefined) {
    helper = keyedHelperName(lowerer, "%builtin.member", cacheKey);
    lowerer.valueHelpers.set(cacheKey, helper);
    const k = varRef("k.0", STRING, loc);
    const answer = (value: boolean): IrStmt => ({
      kind: "return",
      value: { kind: "boolLit", value, type: BOOL, loc },
      loc,
    });
    // Group the names by UTF-16 length, in ascending length order.
    const byLength = new Map<number, string[]>();
    for (const name of names) {
      const group = byLength.get(name.length);
      if (group === undefined) byLength.set(name.length, [name]);
      else group.push(name);
    }
    const groups = [...byLength.entries()].sort((a, b) => a[0] - b[0]);
    const n = (): IrExpr => varRef("n.0", F64, loc);
    /** Compare the key against one length group's names, then answer no. */
    const compareGroup = (members: readonly string[]): IrStmt[] => {
      const checks: IrStmt[] = [];
      for (const name of members) {
        checks.push({
          kind: "if",
          cond: {
            kind: "strEq",
            negated: false,
            left: k,
            right: { kind: "strLit", value: name, type: STRING, loc },
            type: BOOL,
            loc,
          },
          then: [answer(true)],
          else_: null,
          loc,
        });
      }
      checks.push(answer(false));
      return checks;
    };
    /** Balanced search over the ascending length groups. */
    const search = (lo: number, hi: number): IrStmt[] => {
      if (lo > hi) return [answer(false)];
      const mid = (lo + hi) >> 1;
      const [length, members] = groups[mid]!;
      return [
        {
          kind: "if",
          cond: { kind: "bin", op: "===", left: n(), right: numLit(length, loc), type: BOOL, loc },
          then: compareGroup(members),
          else_: [
            {
              kind: "if",
              cond: {
                kind: "bin",
                op: "<",
                left: n(),
                right: numLit(length, loc),
                type: BOOL,
                loc,
              },
              then: search(lo, mid - 1),
              else_: search(mid + 1, hi),
              loc,
            },
          ],
          loc,
        },
      ];
    };
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "n.0",
        init: { kind: "strIntrinsic", method: "length", receiver: k, args: [], type: F64, loc },
        loc,
      },
      ...(groups.length === 0 ? [answer(false)] : search(0, groups.length - 1)),
    ];
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "k.0", name: "k", type: STRING }],
      returnType: BOOL,
      locals: [
        { id: "k.0", name: "k", type: STRING, mutable: true },
        { id: "n.0", name: "n", type: F64, mutable: false },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [key], type: BOOL, loc };
}

/** A census answer computed without lowering the expression it reflects on
 * still evaluates that expression, as Node does: Object.keys' argument, the
 * operand of typeof and the receiver of `in` / hasOwnProperty evaluate in
 * source order, so a call there keeps its side effects and exceptions. A
 * pure expression (a binding read, a literal) has nothing to keep, and a
 * spelling whose value the lowerers refuse (an inline require of a builtin
 * module object) keeps answering statically, as it did before. */
export function reflectOverNamespaceExpr(
  lowerer: Lowerer,
  receiver: ts.Expression,
  result: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (sideEffectFreeOptionValue(receiver)) return result;
  const evaluated = tryLowerExpression(lowerer, receiver);
  if (evaluated === null) return result;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: evaluated, loc }],
    result,
    type: result.type,
    loc,
  };
}
