import { constructorEscapePoint } from "../cycle-mutability.js";
import {
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { dynamicFieldStores } from "../../ir/int32-slots.js";
import { everyExpr, everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { InlineUnionFields } from "./inline-unions.js";
import { RESULT_DST_ID, resultEntryName } from "../result-slots.js";

export { RESULT_DST_ID, RESULT_ENTRY_PREFIX, resultEntryName } from "../result-slots.js";

function distinctNames(names: readonly string[]): boolean {
  return new Set(names).size === names.length;
}

/** A plain record shape whose fields are numbers, booleans and inline
 * scalar unions (inline-unions.ts): its fields own nothing. */
export function scalarRecordShape(
  shape: IrRecordShape | undefined,
  inline: InlineUnionFields,
): boolean {
  return (
    shape !== undefined &&
    !shape.indexValue &&
    !shape.tuple &&
    shape.fields.every(
      (field) =>
        field.type.kind === "f64" || field.type.kind === "bool" || inline.record(field.type),
    )
  );
}

/** A closed record or tuple shape: declared fields only. Its instance can
 * live in caller storage; fields that own references are released by the
 * frame that holds the storage (stack-objects.ts). Tuples are element
 * records: destructuring and element reads project them, and every
 * array-like use of one is a whole-value use that keeps it on the heap. */
export function frameRecordShape(shape: IrRecordShape | undefined): boolean {
  return shape !== undefined && !shape.indexValue;
}

/** A literal that stores every field of its shape, none of them through
 * the overflow map, and that sets no overflow-map flag. */
export function completeRecordLiteral(
  e: IrExpr & { kind: "recordLit" },
  shape: IrRecordShape | undefined,
): boolean {
  if (!shape || e.nullProto || e.fields.some((field) => field.overflow)) return false;
  const names = new Set(e.fields.map((field) => field.name));
  return shape.fields.every((field) => names.has(field.name));
}

/** A standalone class whose fields are numbers, booleans and inline scalar
 * unions, and whose constructor never lets `this` escape: its instance can
 * be built in caller-provided storage. */
export function scalarStandaloneClass(
  cls: IrClassDef | undefined,
  ctor: IrFunction | undefined,
  isBase: boolean,
  programLifetime: boolean,
  inline: InlineUnionFields,
): boolean {
  if (
    !cls ||
    !ctor ||
    isBase ||
    programLifetime ||
    cls.runtime ||
    cls.base !== undefined ||
    cls.localCaptures !== undefined ||
    cls.tracksOwnFields ||
    (cls.symbolFields?.length ?? 0) > 0 ||
    ctor.async ||
    ctor.generator ||
    !cls.fields.every(
      (field) =>
        field.type.kind === "f64" ||
        field.type.kind === "bool" ||
        inline.classField(cls.name, field.name),
    )
  )
    return false;
  const self = ctor.params[0]?.localId;
  return self !== undefined && constructorEscapePoint(ctor, self, null) === ctor.body.length;
}

/** Whether the constructor's top-level statements store every field of
 * `this` before anything reads a field it has not stored yet. Storage for
 * such an instance needs no zeroing first. */
export function constructorInitializesFields(cls: IrClassDef, ctor: IrFunction): boolean {
  const self = ctor.params[0]?.localId;
  if (self === undefined) return false;
  const stored = new Set<string>();
  const unstoredRead = {
    expr: (node: IrExpr): boolean =>
      !(
        node.kind === "fieldGet" &&
        node.obj.kind === "varRef" &&
        node.obj.localId === self &&
        !stored.has(node.field)
      ),
    stmt: () => true,
  };
  for (const stmt of ctor.body) {
    if (stmt.kind === "fieldSet" && stmt.obj.kind === "varRef" && stmt.obj.localId === self) {
      if (!everyExpr(stmt.value, unstoredRead)) return false;
      stored.add(stmt.field);
    } else if (!everyStmtList([stmt], unstoredRead)) return false;
  }
  return cls.fields.every((field) => stored.has(field.name));
}

/** Add a result-slot entry for every function whose returns all build a
 * fresh closed record or standalone scalar object, return another such
 * producer's result (forwarding the slot), or return a parameter of a
 * record shape no store can change (copied into the slot). The original
 * function stays as it is; the backend calls the entry only where the
 * result is proven to be consumed by projections, passing frame storage. */
export function addRecordResultEntries(mod: IrModule): IrModule {
  const shapes = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  // Scalar unions are always tagged boxes, so the full union table decides
  // inline fields exactly as the emitter's boxed table does.
  const inline = new InlineUnionFields(
    new Map((mod.unions ?? []).map((def) => [def.id, def])),
    mod.classes ?? [],
  );
  const classes = new Map((mod.classes ?? []).map((cls) => [cls.name, cls]));
  const bases = new Set((mod.classes ?? []).flatMap((cls) => (cls.base ? [cls.base] : [])));
  const lifetime = new Set(mod.contracts?.programLifetime ?? []);
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const stackClass = (name: string): boolean =>
    scalarStandaloneClass(
      classes.get(name),
      functions.get(`%${name}.constructor`),
      bases.has(name),
      lifetime.has(name),
      inline,
    );
  // Shapes no store can change after construction: no record field write
  // in the program, no dynamic store that can name a field, and no native
  // boundary. A returned value of such a shape can be copied instead of
  // shared, since nothing can tell the copy from the original once `===`
  // and field writes are ruled out by the caller's projection proof.
  const written = new Set<string>();
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      expr: () => true,
      stmt: (stmt) => {
        if (
          stmt.kind === "recordSet" ||
          stmt.kind === "recordKeySet" ||
          stmt.kind === "recordKeyDelete"
        )
          written.add(stmt.shapeId);
        return true;
      },
    });
  const dynamicStores = dynamicFieldStores(mod);
  // Copies are limited to scalar shapes: a copy of a reference-owning
  // record would not carry the undeclared source keys a checked conversion
  // may keep beside the original (record-sources.ts).
  const copyable = (type: IrType): boolean =>
    type.kind === "record" &&
    scalarRecordShape(shapes.get(type.shapeId), inline) &&
    mod.lib === undefined &&
    !written.has(type.shapeId) &&
    !dynamicStores.all &&
    !(shapes.get(type.shapeId)?.fields ?? []).some((field) => dynamicStores.names.has(field.name));
  const producers = new Set<string>();
  const fillable = (value: IrExpr, params: ReadonlySet<string>): boolean => {
    switch (value.kind) {
      case "recordLit":
        return (
          completeRecordLiteral(
            value,
            shapes.get((value.type as IrType & { kind: "record" }).shapeId),
          ) && distinctNames(value.fields.map((field) => field.name))
        );
      case "new":
        return stackClass(value.className);
      case "ternary":
        return fillable(value.then, params) && fillable(value.else_, params);
      case "varRef":
        return params.has(value.localId) && copyable(value.type);
      case "recordClone":
        // A spread of a binding: the copies read it before any override
        // evaluates, as the heap clone does.
        return (
          value.source.kind === "varRef" &&
          value.type.kind === "record" &&
          frameRecordShape(shapes.get(value.type.shapeId)) &&
          distinctNames(value.overrides.map((override) => override.name))
        );
      case "call":
        return producers.has(value.callee);
      default:
        return false;
    }
  };
  const fill = (value: IrExpr, dst: IrExpr): IrStmt[] => {
    switch (value.kind) {
      case "recordLit":
        return value.fields.map((field) => ({
          kind: "recordSet",
          obj: dst,
          shapeId: (value.type as IrType & { kind: "record" }).shapeId,
          field: field.name,
          value: field.value,
          loc: field.value.loc,
        }));
      case "varRef": {
        const shapeId = (value.type as IrType & { kind: "record" }).shapeId;
        return shapes.get(shapeId)!.fields.map((field) => ({
          kind: "recordSet",
          obj: dst,
          shapeId,
          field: field.name,
          value: {
            kind: "recordGet",
            obj: value,
            shapeId,
            field: field.name,
            type: field.type,
            loc: value.loc,
          },
          loc: value.loc,
        }));
      }
      case "recordClone": {
        const shapeId = (value.type as IrType & { kind: "record" }).shapeId;
        const overridden = new Set(value.overrides.map((override) => override.name));
        const copies: IrStmt[] = shapes
          .get(shapeId)!
          .fields.filter((field) => !overridden.has(field.name))
          .map((field): IrStmt => ({
            kind: "recordSet",
            obj: dst,
            shapeId,
            field: field.name,
            value: {
              kind: "recordGet",
              obj: value.source,
              shapeId,
              field: field.name,
              type: field.type,
              loc: value.loc,
            },
            loc: value.loc,
          }));
        return [
          ...copies,
          ...value.overrides.map((override): IrStmt => ({
            kind: "recordSet",
            obj: dst,
            shapeId,
            field: override.name,
            value: override.value,
            loc: override.value.loc,
          })),
        ];
      }
      case "call":
        return [
          {
            kind: "exprStmt",
            expr: {
              kind: "call",
              callee: resultEntryName(value.callee),
              args: [...value.args, dst],
              type: VOID,
              loc: value.loc,
            },
            loc: value.loc,
          },
        ];
      case "new":
        return [
          {
            kind: "exprStmt",
            expr: {
              kind: "call",
              callee: `%${value.className}.constructor`,
              args: [dst, ...value.args],
              type: VOID,
              loc: value.loc,
            },
            loc: value.loc,
          },
        ];
      case "ternary":
        return [
          {
            kind: "if",
            cond: value.cond,
            then: fill(value.then, dst),
            else_: fill(value.else_, dst),
            loc: value.loc,
          },
        ];
      default:
        throw new Error("unreachable");
    }
  };
  // fill() turns a returned literal into one store statement per field. A
  // seqExpr's hidden locals live through their enclosing expression only,
  // so a field may lift statements (`this.i++` saves its receiver and old
  // value) as long as no other field names a local declared inside it.
  const declaredIn = (value: IrExpr): Set<string> => {
    const ids = new Set<string>();
    everyExpr(value, {
      expr: () => true,
      stmt: (s) => {
        if (s.kind === "varDecl") ids.add(s.localId);
        return true;
      },
    });
    return ids;
  };
  const mentions = (value: IrExpr, ids: ReadonlySet<string>): boolean =>
    !everyExpr(value, {
      expr: (e) => {
        switch (e.kind) {
          case "varRef":
          case "assignExpr":
          case "incDec":
            return !ids.has(e.localId);
          case "closure":
            return !e.captures.some((id) => ids.has(id));
          default:
            return true;
        }
      },
      stmt: (s) => {
        switch (s.kind) {
          case "varDecl":
          case "assign":
            return !ids.has(s.localId);
          default:
            return true;
        }
      },
    });
  const lifted = (value: IrExpr): boolean =>
    !everyExpr(value, { expr: (e) => e.kind !== "seqExpr", stmt: () => true });
  // Whether a return value splits safely; records in `out` the seqExprs the
  // split may contain.
  const splitSeqs = (value: IrExpr, out: Set<IrExpr>): boolean => {
    switch (value.kind) {
      case "recordLit": {
        const fields = value.fields.map((field) => field.value);
        for (let i = 0; i < fields.length; i++) {
          if (!lifted(fields[i]!)) continue;
          const ids = declaredIn(fields[i]!);
          for (let j = 0; j < fields.length; j++)
            if (j !== i && mentions(fields[j]!, ids)) return false;
          everyExpr(fields[i]!, {
            expr: (e) => {
              if (e.kind === "seqExpr") out.add(e);
              return true;
            },
            stmt: () => true,
          });
        }
        return true;
      }
      case "ternary":
        return !lifted(value.cond) && splitSeqs(value.then, out) && splitSeqs(value.else_, out);
      default:
        // Calls, constructions and copies keep their operands in one
        // expression; nothing is split.
        return !lifted(value);
    }
  };
  const candidates = mod.functions.filter((fn) => {
    if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures !== undefined)
      return false;
    const ret = fn.returnType;
    return (
      (ret.kind === "record" && frameRecordShape(shapes.get(ret.shapeId))) ||
      (ret.kind === "object" && stackClass(ret.className))
    );
  });
  for (const fn of candidates) producers.add(fn.name);
  // Greatest fixpoint: a producer may return another producer's result.
  const eligible = (fn: IrFunction): boolean => {
    const params = new Set(fn.params.map((param) => param.localId));
    let returns = 0;
    const splittable = new Set<IrExpr>();
    const ok = everyStmtList(fn.body, {
      expr: (e) => e.kind !== "seqExpr" || splittable.has(e),
      stmt: (s) => {
        if (s.kind !== "return") return s.kind !== "tryCatch";
        returns++;
        // Visited before its value's expressions.
        return s.value !== null && fillable(s.value, params) && splitSeqs(s.value, splittable);
      },
    });
    return ok && returns > 0;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of candidates)
      if (producers.has(fn.name) && !eligible(fn)) {
        producers.delete(fn.name);
        changed = true;
      }
  }
  const added: IrFunction[] = [];
  for (const fn of candidates) {
    if (!producers.has(fn.name)) continue;
    const ret = fn.returnType;
    const dstId = RESULT_DST_ID;
    const dst: IrExpr = { kind: "varRef", localId: dstId, type: ret, loc: fn.loc };
    const body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (s) =>
        s.kind === "return" && s.value !== null
          ? { kind: "block", body: [...fill(s.value, dst), { ...s, value: null }], loc: s.loc }
          : s,
    });
    const { sourceName: _sourceName, ownsPrototype: _ownsPrototype, ...rest } = fn;
    added.push({
      ...rest,
      name: resultEntryName(fn.name),
      params: [...fn.params, { localId: dstId, name: "dst", type: ret }],
      locals: [...fn.locals, { id: dstId, name: "dst", type: ret, mutable: false }],
      returnType: VOID,
      body,
    });
  }
  return added.length === 0 ? mod : { ...mod, functions: [...mod.functions, ...added] };
}
