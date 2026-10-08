import { countedFor, numLit, varRef } from "../../../ir/build.js";
import {
  BOOL,
  F64,
  arrayOf,
  typeEquals,
  typeKey,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";
import type * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";

/** Copy into fresh storage after every argument has evaluated. Array
 * arguments retain their own element ABI; only copied values are widened.
 * Missing slots stay holes and present undefined stays present. */
export function arrayConcatHelper(
  lowerer: Lowerer,
  elem: IrType,
  shape: (IrType | null)[],
  node: ts.CallExpression,
  loc: SrcLoc,
): string {
  const key = `concat:${typeKey(elem)}:${shape.map((type) => (type ? `a:${typeKey(type)}` : "e")).join(";")}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%arr.concat.${lowerer.arrHofHelpers.size}`;
  const arrT = arrayOf(elem);
  const params = [
    { localId: "a.0", name: "a", type: arrT },
    ...shape.map((type, i) => ({
      localId: `x.${i}`,
      name: `x${i}`,
      type: type ? arrayOf(type) : elem,
    })),
  ];
  const locals: IrLocal[] = params.map((p) => ({
    id: p.localId,
    name: p.name,
    type: p.type,
    mutable: false,
  }));
  locals.push({ id: "out.0", name: "out", type: arrT, mutable: false });
  const out = varRef("out.0", arrT, loc);
  const length = (value: IrExpr): IrExpr => ({
    kind: "arrIntrinsic",
    method: "length",
    receiver: value,
    args: [],
    type: F64,
    loc,
  });
  const append = (source: IrExpr, sourceElem: IrType | null, site: ts.Node): IrStmt[] => {
    if (sourceElem === null || typeEquals(sourceElem, elem))
      return [
        {
          kind: "exprStmt",
          expr: {
            kind: "arrIntrinsic",
            method: sourceElem ? "concatSpread" : "push",
            receiver: out,
            args: [source],
            type: F64,
            loc,
          },
          loc,
        },
      ];
    if (!identityPreservingWidening(lowerer, sourceElem, elem)) {
      lowerer.unsupported(
        "SC1090",
        site,
        "concat array elements requiring a structural copy (use a shared element type to preserve element identity)",
      );
    }
    const index = varRef("i.0", F64, loc);
    const offset = varRef("offset.0", F64, loc);
    const count = varRef("count.0", F64, loc);
    const destination: IrExpr = {
      kind: "bin",
      op: "+",
      left: offset,
      right: index,
      type: F64,
      loc,
    };
    const value = lowerer.coerceInto(
      site,
      { kind: "arrayGet", arr: source, index, type: sourceElem, loc },
      elem,
    );
    return [
      { kind: "varDecl", localId: "offset.0", init: length(out), loc },
      { kind: "varDecl", localId: "count.0", init: length(source), loc },
      {
        kind: "arraySetLength",
        arr: out,
        length: { kind: "bin", op: "+", left: offset, right: count, type: F64, loc },
        loc,
      },
      countedFor(loc, count, () => [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "===",
            left: { kind: "arrayState", arr: source, index, type: F64, loc },
            right: numLit(1, loc),
            type: BOOL,
            loc,
          },
          then: [{ kind: "arraySet", arr: out, index: destination, value, loc }],
          else_: [
            {
              kind: "if",
              cond: {
                kind: "bin",
                op: "===",
                left: { kind: "arrayState", arr: source, index, type: F64, loc },
                right: numLit(2, loc),
                type: BOOL,
                loc,
              },
              then: [{ kind: "arraySetUndefined", arr: out, index: destination, loc }],
              else_: null,
              loc,
            },
          ],
          loc,
        },
      ]),
    ];
  };
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: arrT, loc },
      loc,
    },
    ...append(varRef("a.0", arrT, loc), elem, node.expression),
    ...shape.flatMap((type, i) =>
      append(varRef(`x.${i}`, type ? arrayOf(type) : elem, loc), type, node.arguments[i]!),
    ),
    { kind: "return", value: out, loc },
  ];
  if (shape.some((type) => type && !typeEquals(type, elem))) {
    for (const id of ["i.0", "offset.0", "count.0"])
      locals.push({ id, name: id, type: F64, mutable: true });
  }
  lowerer.arrHofHelpers.set(key, name);
  lowerer.liftedFns.push({ name, params, returnType: arrT, locals, body, loc });
  return name;
}

function identityPreservingWidening(lowerer: Lowerer, source: IrType, target: IrType): boolean {
  if (typeEquals(source, target)) return true;
  if (source.kind === "object" && target.kind === "object")
    return lowerer.isSubclassOf(source.className, target.className);
  if (source.kind === "union")
    return (
      lowerer.unions
        .get(source.unionId)
        ?.arms.every((arm) => identityPreservingWidening(lowerer, arm, target)) ?? false
    );
  if (target.kind === "union")
    return (
      lowerer.unions
        .get(target.unionId)
        ?.arms.some((arm) => identityPreservingWidening(lowerer, source, arm)) ?? false
    );
  return false;
}
