/* LifetimeRegion (@scriptc/experimental): an allocation context for
 * ProgramLifetime instances (backend/llvm/regions.ts, scr_region.c).
 *
 * A LifetimeRegion value is an instance of the synthetic class
 * `%LifetimeRegion` whose one private field holds the runtime region id, so
 * it has the identity, typeof and inspection of the Node.js class (whose
 * instances have no own properties). The surface lowers at its use sites:
 * - `new LifetimeRegion()` constructs the class; its constructor creates
 *   the region (region.create);
 * - `region.run(fn)` calls an interned helper per callback type that
 *   enters the region, calls `fn`, and leaves it in a `finally`, so the
 *   region is left however `fn` completes;
 * - `region.release()` condemns the region (region.release).
 * Any other use of the class or its methods as values is refused. The
 * module is marked lifetimeRegions, which moves every ProgramLifetime
 * class into counted regions. */
import { keyedHelperName } from "./stable-names.js";
import { F64, VOID, funcOf, typeKey } from "../../ir/ir.js";
import type { IrExpr, IrFunction, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { experimentalImportOf, lifetimeRegionMemberOf } from "../experimental-import.js";
import * as ts from "../ts7/adapter.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";

export const LIFETIME_REGION_CLASS = "%LifetimeRegion";
const REGION_FIELD = "#region";

const BUILTIN_LOC: SrcLoc = { file: "<builtin>", start: 0, end: 0 };

/** The LifetimeRegion instance type, registering the class (and its
 * constructor) on first use. */
export function lifetimeRegionType(lowerer: Lowerer): IrType {
  const type: IrType = { kind: "object", className: LIFETIME_REGION_CLASS };
  if (lowerer.classes.has(LIFETIME_REGION_CLASS)) return type;
  const info: ClassInfo = {
    def: {
      name: LIFETIME_REGION_CLASS,
      fields: [{ name: REGION_FIELD, type: F64 }],
      loc: BUILTIN_LOC,
    },
    fields: new Map(),
    fieldOrder: [],
    methods: new Map(),
    decl: null,
    lifetimeRegion: true,
    ctor: null,
    ctorParams: [],
    base: null,
    subclasses: [],
    throwingSetters: [],
    staticFields: [],
  };
  lowerer.classes.set(LIFETIME_REGION_CLASS, info);
  lowerer.usesLifetimeRegions = true;
  const self: IrExpr = { kind: "varRef", localId: "this.0", type, loc: BUILTIN_LOC };
  lowerer.liftedFns.push({
    name: `%${LIFETIME_REGION_CLASS}.constructor`,
    params: [{ localId: "this.0", name: "this", type }],
    returnType: VOID,
    locals: [{ id: "this.0", name: "this", type, mutable: false }],
    body: [
      {
        kind: "fieldSet",
        obj: self,
        className: LIFETIME_REGION_CLASS,
        field: REGION_FIELD,
        value: { kind: "intrinsic", name: "region.create", args: [], type: F64, loc: BUILTIN_LOC },
        loc: BUILTIN_LOC,
      },
    ],
    loc: BUILTIN_LOC,
  });
  return type;
}

/** `new LifetimeRegion()`. */
export function lowerLifetimeRegionNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  if (experimentalImportOf(lowerer.program, expr.expression) !== "LifetimeRegion") return null;
  if ((expr.arguments?.nodes.length ?? 0) !== 0)
    lowerer.noLowering(`new LifetimeRegion with ${expr.arguments!.nodes.length} arguments`, expr);
  const type = lifetimeRegionType(lowerer);
  return { kind: "new", className: LIFETIME_REGION_CLASS, args: [], type, loc: locOf(expr) };
}

/** `region.run(fn)` and `region.release()`. */
export function lowerLifetimeRegionCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const member = lifetimeRegionMemberOf(lowerer.program, callee, lowerer.experimentalFiles);
  if (member === null) return null;
  // `region?.release()`: the optional-chain lowering binds the receiver
  // and dispatches the call again (optional-chains.ts).
  if (callee.questionDotToken !== undefined && !lowerer.chainHandled.has(callee)) return null;
  const loc = locOf(expr);
  const type = lifetimeRegionType(lowerer);
  if (expr.questionDotToken !== undefined)
    lowerer.noLowering(
      `LifetimeRegion.${member}?.() calls`,
      expr,
      `call region.${member}() directly`,
    );
  const region = lowerer.coerceInto(callee.expression, lowerer.lowerExpr(callee.expression), type);
  if (member === "release") {
    if (expr.arguments.nodes.length !== 0)
      lowerer.noLowering(
        `LifetimeRegion.release with ${expr.arguments.nodes.length} arguments`,
        expr,
      );
    return {
      kind: "intrinsic",
      name: "region.release",
      args: [
        {
          kind: "fieldGet",
          obj: region,
          className: LIFETIME_REGION_CLASS,
          field: REGION_FIELD,
          type: F64,
          loc,
        },
      ],
      type: VOID,
      loc,
    };
  }
  const arg = expr.arguments.nodes[0];
  if (expr.arguments.nodes.length !== 1 || arg === undefined || ts.isSpreadElement(arg))
    lowerer.noLowering(`LifetimeRegion.run with ${expr.arguments.nodes.length} arguments`, expr);
  const resultTs = lowerer.typeOf(expr);
  const mapped = resultTs.flags & ts.TypeFlags.Void ? VOID : lowerer.mapTypeOf(resultTs);
  if (mapped === null) lowerer.badType(expr, resultTs);
  const ret = mapped!;
  const fnType = funcOf([], ret) as IrType & { kind: "func" };
  const fn = lowerer.coerceInto(arg!, lowerer.lowerExpr(arg!), fnType);
  return {
    kind: "call",
    callee: runHelper(lowerer, fnType, loc),
    args: [region, fn],
    type: ret,
    loc,
  };
}

/** The interned `%LifetimeRegion.run.<n>` helper for one callback type:
 *
 *     const id = region.#region;
 *     region.enter(id);
 *     try { return fn(); } finally { region.leave(); }
 */
function runHelper(lowerer: Lowerer, fnType: IrType & { kind: "func" }, loc: SrcLoc): string {
  const key = typeKey(fnType);
  const known = lowerer.regionRunHelpers.get(key);
  if (known !== undefined) return known;
  const name = keyedHelperName(lowerer, `%${LIFETIME_REGION_CLASS}.run`, key);
  lowerer.regionRunHelpers.set(key, name);
  const regionT = lifetimeRegionType(lowerer);
  const ret = fnType.ret;
  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const call: IrExpr = { kind: "callValue", callee: ref("fn.0", fnType), args: [], type: ret, loc };
  const guarded: IrStmt[] =
    ret.kind === "void"
      ? [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ]
      : [{ kind: "return", value: call, loc }];
  const fn: IrFunction = {
    name,
    params: [
      { localId: "region.0", name: "region", type: regionT },
      { localId: "fn.0", name: "fn", type: fnType },
    ],
    returnType: ret,
    locals: [
      { id: "region.0", name: "region", type: regionT, mutable: false },
      { id: "fn.0", name: "fn", type: fnType, mutable: false },
      { id: "id.0", name: "id", type: F64, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "id.0",
        init: {
          kind: "fieldGet",
          obj: ref("region.0", regionT),
          className: LIFETIME_REGION_CLASS,
          field: REGION_FIELD,
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "exprStmt",
        expr: {
          kind: "intrinsic",
          name: "region.enter",
          args: [ref("id.0", F64)],
          type: VOID,
          loc,
        },
        loc,
      },
      {
        kind: "tryCatch",
        tryBody: guarded,
        catchBody: null,
        catchLocalId: null,
        finallyBody: [
          {
            kind: "exprStmt",
            expr: { kind: "intrinsic", name: "region.leave", args: [], type: VOID, loc },
            loc,
          },
        ],
        loc,
      },
    ],
    loc,
  };
  lowerer.liftedFns.push(fn);
  return name;
}
