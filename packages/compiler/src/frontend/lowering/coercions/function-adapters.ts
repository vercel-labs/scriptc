import { dynUndefinedExpr } from "../../../ir/build.js";
import { buildFunctionAdapter } from "./builders.js";
import { InternalCompilerError } from "../../../errors.js";
import type { IrExpr, IrParam, IrStmt, IrType, SrcLoc } from "../../../ir/ir.js";
import {
  canAdaptDynFuncTo,
  canMarshalTypedFuncIntoIsland,
  DYN,
  F64,
  isUnitType,
  JSVAL,
  STRING,
  typeEquals,
  UNDEFINED_T,
} from "../../../ir/ir.js";
import { typeKey } from "../../type-mapper.js";
import type { Lowerer } from "../lowerer.js";

/** Wrap a zero-argument function whose array result needs an element
 * conversion. Each invocation creates a fresh converted array; the factory
 * creates a fresh closure capturing the original function. */
export function funcReturnWidthAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  if (fromT.params.length !== 0 || toT.params.length !== 0) return null;
  if (fromT.ret.kind !== "array" || toT.ret.kind !== "array") return null;
  const mapper = lowerer.arrayWidthHelper(fromT.ret, toT.ret, loc);
  if (!mapper) return null;
  const key = `fn:${typeKey(fromT.ret.elem)}:${typeKey(toT.ret.elem)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = `%fn.width.${lowerer.valueHelpers.size}`;
  lowerer.valueHelpers.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  // The returned closure's body: call the captured original, width-map.
  lowerer.liftedFns.push(
    ...buildFunctionAdapter(
      name,
      fromT,
      toT,
      [],
      [],
      [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: mapper,
            args: [
              {
                kind: "callValue",
                callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
                receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
                args: [],
                type: fromT.ret,
                loc,
              },
            ],
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    ),
  );
  return name;
}

/** Probe mechanical value conversions without creating helpers.
 * Trap-only conversions are excluded: they cannot justify an adapter that
 * promises to accept the destination signature. */
export function coercibleValue(lowerer: Lowerer, src: IrType, dst: IrType): boolean {
  if (typeEquals(src, dst)) return true;
  if (src.kind === "object" && dst.kind === "object")
    return lowerer.isSubclassOf(src.className, dst.className);
  // The island boundary joins the mechanical set: values that MARSHAL
  // in (units, the checked-dynamic deep copy, JSON-safe data, liftable
  // composites, marshalable closures — coerceToExpected's jsval-IN
  // block) and island handles whose exits VALIDATE (boundaryExitSafe) —
  // the `defaultFallback(cfg) { return { login, id, scopes } }` shape,
  // whose slot returns a package ('any') type.
  if (dst.kind === "jsval") {
    return (
      src.kind !== "jsval" &&
      (isUnitType(src) ||
        src.kind === "dyn" ||
        lowerer.boundarySafe(src) ||
        lowerer.jsvalLiftable(src) ||
        (src.kind === "func" &&
          canMarshalTypedFuncIntoIsland(
            src,
            (id) => lowerer.shapes.get(id),
            (id) => lowerer.unions.get(id),
          )))
    );
  }
  if (src.kind === "jsval") return lowerer.boundaryExitSafe(dst);
  if (dst.kind === "dyn") return src.kind !== "dyn" && lowerer.dynConvertible(src);
  if (src.kind === "dyn") {
    // The checked-dynamic function boundary's OUT direction joins the
    // mechanical set: a dyn result landing in an adaptable func slot
    // takes dynCheck's per-target shim (coerceToExpected's funcOk rule
    // — the production/development function-choice ternary shape).
    return (
      lowerer.jsonSafe(dst) ||
      (dst.kind === "func" &&
        canAdaptDynFuncTo(
          dst,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        ))
    );
  }
  if (dst.kind === "union") {
    if (src.kind === "union") return lowerer.unionRetagMappable(src.unionId, dst.unionId);
    if (src.kind === "void") return lowerer.armTag(dst.unionId, UNDEFINED_T) >= 0;
    return !isUnitType(src) && lowerer.armTag(dst.unionId, src) >= 0;
  }
  if (src.kind === "union") {
    return !isUnitType(dst) && dst.kind !== "void" && lowerer.armTag(src.unionId, dst) >= 0;
  }
  return false;
}

/** Whether all parameters and the result adapt without a trap-only path.
 * Rest signatures are excluded; extra destination parameters are ignored. */
export function cleanFuncAdaptable(
  lowerer: Lowerer,
  src: IrType & { kind: "func" },
  dst: IrType & { kind: "func" },
): boolean {
  if (src.rest === true || dst.rest === true) return false;
  if (src.params.length > dst.params.length) return false;
  for (let i = 0; i < src.params.length; i++) {
    if (!lowerer.coercibleValue(dst.params[i]!, src.params[i]!)) return false;
  }
  if (dst.ret.kind === "void") return src.ret.kind !== "jsval";
  if (lowerer.coercibleValue(src.ret, dst.ret)) return true;
  return src.ret.kind === "void" && (dst.ret.kind === "dyn" || dst.ret.kind === "jsval");
}

/** Adapt a function value to a destination signature, forwarding and
 * converting its arguments and result. Unsupported parameter/result pairs
 * produce checked traps when called; rest signatures remain refused. */
export function funcCoerceAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  if (fromT.rest === true || toT.rest === true) return null;
  if (fromT.params.length > toT.params.length) return null;
  // Piece dispositions beyond coercibleValue, all CHECKER-APPROVED
  // function compatibilities (bivariant method params under the suite's
  // non-strict settings, `() => never` throwers displayed as void by
  // the type mapping, void functions into unknown/any-returning slots):
  // - strandParams: some parameter cannot convert — the assignment
  //   compiles, INVOKING the slot throws the stranded TypeError (a
  //   never-called mismatched callback is exact; divergence 38's stance
  //   extended to calls).
  // - voidRet "dyn"/"jsval": calling yields JS's undefined — the exact
  //   undefined dyn/engine value after the call's effects.
  // - voidRet "strand": a void result where the slot promises a typed
  //   value — the call runs (a `never` thrower never comes back, so the
  //   trap is unreachable there), then the stranded TypeError.
  let strandParams = false;
  const narrowedParams = new Map<number, ReadonlySet<number>>();
  const partialDynParams = new Map<number, IrType>();
  for (let i = 0; i < fromT.params.length; i++) {
    const actual = toT.params[i]!;
    const expected = fromT.params[i]!;
    if (lowerer.coercibleValue(actual, expected)) continue;
    if (actual.kind === "union" && expected.kind === "dyn") {
      const arms =
        lowerer.unions.get(actual.unionId)?.arms.filter((arm) => lowerer.dynConvertible(arm)) ?? [];
      if (arms.length > 0) {
        partialDynParams.set(
          i,
          arms.length === 1 ? arms[0]! : { kind: "union", unionId: lowerer.unions.intern(arms) },
        );
        continue;
      }
    }
    // A stored native builtin can have a narrower supported overload
    // than its public declaration. Preserve every supported union arm
    // and reject only an invocation carrying an unsupported arm. This
    // is the union counterpart of the checked single-arm extraction.
    if (actual.kind === "union" && expected.kind === "union") {
      const source = lowerer.unions.get(actual.unionId);
      const target = lowerer.unions.get(expected.unionId);
      if (
        source &&
        target &&
        target.arms.every((arm) => lowerer.armTag(actual.unionId, arm) >= 0)
      ) {
        narrowedParams.set(
          i,
          new Set(
            source.arms.flatMap((arm, tag) =>
              lowerer.armTag(expected.unionId, arm) < 0 ? [tag] : [],
            ),
          ),
        );
        continue;
      }
    }
    strandParams = true;
  }
  let voidRet: "dyn" | "jsval" | "strand" | null = null;
  let strandRet = false;
  if (toT.ret.kind !== "void" && !lowerer.coercibleValue(fromT.ret, toT.ret)) {
    if (fromT.ret.kind !== "void") {
      // A RESULT that cannot convert — the strandParams stance, result
      // side (the production/development function-choice ternary: the
      // untaken arm's result shape never lands in the slot's): the
      // assignment compiles, INVOKING the slot runs the function and
      // throws the stranded TypeError where its result would convert.
      strandRet = true;
    } else {
      voidRet = toT.ret.kind === "dyn" ? "dyn" : toT.ret.kind === "jsval" ? "jsval" : "strand";
    }
  }
  if (toT.ret.kind === "void" && fromT.ret.kind === "jsval") return null;
  const key = `fnadapt:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = `%fn.adapt.${lowerer.coercions.retags.size}`;
  lowerer.coercions.retags.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = toT.params.map((t, i) => ({
    localId: `a.${i}`,
    name: `a${i}`,
    type: t,
  }));
  const strandThrow = (why: string): IrStmt => ({
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [{ kind: "strLit", value: why, type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  });
  let body: IrStmt[];
  if (strandParams) {
    body = [
      strandThrow(
        `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the parameter types cannot convert — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
      ),
    ];
  } else {
    const args = fromT.params.map((pt, i) => {
      const aRef: IrExpr = { kind: "varRef", localId: `a.${i}`, type: toT.params[i]!, loc };
      const partial = partialDynParams.get(i);
      if (partial && aRef.type.kind === "union") {
        const source = lowerer.unions.get(aRef.type.unionId)!;
        const supported =
          partial.kind === "union" ? lowerer.unions.get(partial.unionId)!.arms : [partial];
        const rejected = new Set(
          source.arms.flatMap((arm, tag) =>
            supported.some((accepted) => typeEquals(accepted, arm)) ? [] : [tag],
          ),
        );
        const narrow =
          partial.kind === "union"
            ? lowerer.unionRetagHelper(aRef.type.unionId, partial.unionId, loc, rejected)
            : lowerer.narrowedArmHelper(aRef.type.unionId, partial, loc);
        if (!narrow)
          throw new InternalCompilerError(
            "lowerer bug: partial callable parameter stopped narrowing",
          );
        return lowerer.coerceToExpected(
          { kind: "call", callee: narrow, args: [aRef], type: partial, loc },
          pt,
        );
      }
      const narrowed = narrowedParams.get(i);
      const helper =
        narrowed && aRef.type.kind === "union" && pt.kind === "union"
          ? lowerer.unionRetagHelper(aRef.type.unionId, pt.unionId, loc, narrowed)
          : null;
      const converted: IrExpr = helper
        ? { kind: "call", callee: helper, args: [aRef], type: pt, loc }
        : lowerer.coerceToExpected(aRef, pt);
      if (!typeEquals(converted.type, pt))
        throw new InternalCompilerError("lowerer bug: probed fn-adapter param stopped coercing");
      return converted;
    });
    const call: IrExpr = {
      kind: "callValue",
      callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
      receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
      args,
      type: fromT.ret,
      loc,
    };
    if (toT.ret.kind === "void") {
      body = [
        { kind: "exprStmt", expr: call, loc },
        { kind: "return", value: null, loc },
      ];
    } else if (voidRet === "dyn") {
      body = [
        { kind: "exprStmt", expr: call, loc },
        { kind: "return", value: dynUndefinedExpr(loc), loc },
      ];
    } else if (voidRet === "jsval") {
      body = [
        { kind: "exprStmt", expr: call, loc },
        {
          kind: "return",
          value: { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc },
          loc,
        },
      ];
    } else if (voidRet === "strand") {
      body = [
        { kind: "exprStmt", expr: call, loc },
        strandThrow(
          `a void result where the '${lowerer.fmt(toT)}' slot promises '${lowerer.fmt(toT.ret)}' (a thrower typed 'never' never reaches this; a genuinely void function has no result to hand over)`,
        ),
      ];
    } else if (strandRet) {
      body = [
        { kind: "exprStmt", expr: call, loc },
        strandThrow(
          `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the result cannot convert to '${lowerer.fmt(toT.ret)}' — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
        ),
      ];
    } else {
      const result = lowerer.coerceToExpected(call, toT.ret);
      if (!typeEquals(result.type, toT.ret))
        throw new InternalCompilerError("lowerer bug: probed fn-adapter return stopped coercing");
      body = [{ kind: "return", value: result, loc }];
    }
  }
  lowerer.liftedFns.push(...buildFunctionAdapter(name, fromT, toT, params, [], body, loc));
  return name;
}

/** The spawnSync-runner VALUE adapter's plan — a function returning the
 * opaque spawnRes flowing into a slot whose signature returns the
 * STRUCTURAL result record tsc accepted (`defaultRunner` into a
 * `CommandRunner` param: `{ status: number | null; stdout?: string;
 * stderr?: string; error?: Error }`). Parameters must agree pairwise;
 * each target field must be one of the spawnRes reads (status, stdout,
 * stderr, error) at its exact lowered type — string fields optionally
 * undefined-armed. Null when the pair isn't this shape. Pure: callers
 * probe before interning. */
export function spawnResFnAdapterPlan(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
): { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] | null {
  if (!Array.isArray(fromT.params) || !Array.isArray(toT.params)) return null; // defensive: degenerate func types
  if (fromT.params.length !== toT.params.length) return null;
  if (!fromT.params.every((p, i) => typeEquals(p, toT.params[i]!))) return null;
  if (fromT.ret.kind !== "spawnRes" || toT.ret.kind !== "record") return null;
  const shape = lowerer.shapes.get(toT.ret.shapeId);
  if (!shape || shape.tuple || shape.indexValue) return null;
  const statusT: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([F64, { kind: "nullT" }]),
  };
  const errorT: IrType = {
    kind: "union",
    unionId: lowerer.unions.intern([{ kind: "object", className: "%Error" }, UNDEFINED_T]),
  };
  const strOptT: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, UNDEFINED_T]) };
  const plan: { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] = [];
  for (const f of shape.fields) {
    if (f.name === "status" && typeEquals(f.type, statusT)) {
      plan.push({
        field: f.name,
        build: (r, loc) => ({
          kind: "libCall",
          fn: "spawnRes.status",
          args: [r],
          type: statusT,
          loc,
        }),
      });
      continue;
    }
    if (
      (f.name === "stdout" || f.name === "stderr") &&
      (typeEquals(f.type, strOptT) || f.type.kind === "string")
    ) {
      const fn = f.name === "stdout" ? ("spawnRes.stdout" as const) : ("spawnRes.stderr" as const);
      const strTag = lowerer.armTag(strOptT.kind === "union" ? strOptT.unionId : "", STRING);
      plan.push({
        field: f.name,
        build: (r, loc) => {
          const read: IrExpr = { kind: "libCall", fn, args: [r], type: STRING, loc };
          return f.type.kind === "string"
            ? read
            : {
                kind: "unionWrap",
                unionId: (f.type as IrType & { kind: "union" }).unionId,
                tag: strTag,
                value: read,
                type: f.type,
                loc,
              };
        },
      });
      continue;
    }
    if (f.name === "error" && typeEquals(f.type, errorT)) {
      plan.push({
        field: f.name,
        build: (r, loc) => ({
          kind: "libCall",
          fn: "spawnRes.error",
          args: [r],
          type: errorT,
          loc,
        }),
      });
      continue;
    }
    return null;
  }
  return plan;
}

/** Interned `%fnval.spawnres.<n>(f)` — the runner-value adapter: a
 * fresh closure of the TARGET signature forwarding its arguments to the
 * captured function and converting the opaque spawnRes result into the
 * target's structural record (one eager read per declared field —
 * spawnResFnAdapterPlan's set). Divergence caveat: stdout/stderr read
 * as the captured text ("" when nothing was captured, e.g. stdio
 * "inherit") where Node stores null. */
export function spawnResFnAdapter(
  lowerer: Lowerer,
  fromT: IrType & { kind: "func" },
  toT: IrType & { kind: "func" },
  loc: SrcLoc,
): string | null {
  const plan = lowerer.spawnResFnAdapterPlan(fromT, toT);
  if (!plan) return null;
  if (toT.ret.kind !== "record") return null;
  const key = `fnspawn:${typeKey(fromT)}:${typeKey(toT)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = `%fnval.spawnres.${lowerer.valueHelpers.size}`;
  lowerer.valueHelpers.set(key, name);
  lowerer.freshClosureAdapters.add(name);
  const params: IrParam[] = toT.params.map((p, i) => ({
    localId: `p${i}.0`,
    name: `p${i}`,
    type: p,
  }));
  const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: fromT.ret, loc };
  lowerer.liftedFns.push(
    ...buildFunctionAdapter(
      name,
      fromT,
      toT,
      params,
      [{ id: "r.0", name: "r", type: fromT.ret, mutable: false }],
      [
        {
          kind: "varDecl",
          localId: "r.0",
          init: {
            kind: "callValue",
            callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
            receiver: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
            args: params.map((p): IrExpr => ({
              kind: "varRef",
              localId: p.localId,
              type: p.type,
              loc,
            })),
            type: fromT.ret,
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: plan.map((entry) => ({ name: entry.field, value: entry.build(rRef, loc) })),
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    ),
  );
  return name;
}
