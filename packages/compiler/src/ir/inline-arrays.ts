/* Inline array fields (IrContracts.inlineArrays): an array field of a
 * ProgramLifetime class whose elements the backend may keep in the
 * instance itself, after its fixed fields, instead of in an array object.
 *
 * The contract makes that possible: the declaring class's constructor writes
 * the field once, from one of its parameters, and nothing else writes it, so
 * the field's length is the length of a constructor argument and the
 * elements never change. `planInlineArrays` finds the hierarchies where the
 * IR shows exactly that, and the `new` argument each class's instance takes
 * its length from: the declaring class's parameter, or the parameter a
 * subclass constructor passes there through its `super(...)` call. A
 * hierarchy whose IR shows anything else keeps an ordinary array field
 * (the layout is the backend's choice; the field's value is the same).
 *
 * `inlineArrayReads` then prepares the IR for the layout:
 * - a `new` of such a class evaluates its arguments into locals first, in
 *   order, unless every argument is a local or a constant, so that the
 *   backend reads the length after every argument has run and before it
 *   allocates;
 * - an immutable local initialized from the field (`const nodes =
 *   list.nodes`) whose every use indexes it, reads its length or iterates
 *   it with `for...of` is replaced by reads of the field, through a local
 *   holding the instance, so that those reads go straight to the elements. */

import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrLocal,
  IrModule,
  IrStmt,
  IrType,
  SrcLoc,
} from "./ir.js";
import {
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  everyTypeChild,
  transformExpr,
  transformStmtList,
} from "./traverse.js";
import { NORMALIZE, inlineArrayViewIssue } from "./inline-array-views.js";

/** A class whose instances may hold an inline array field. */
export interface InlineArrayClass {
  /** The class that declares the field (the hierarchy's subtree root). */
  readonly declaringClass: string;
  readonly field: string;
  /** The field's index in the class's fields: the same in every class of the
   * subtree, whose field lists extend their bases'. */
  readonly fieldIndex: number;
  /** The class of the elements. */
  readonly elemClass: string;
  /** The index in a `new` expression's `args` of the argument the field is
   * initialized from. */
  readonly lengthArg: number;
}

/** Why a contract entry keeps an ordinary array field. */
export interface InlineArrayRejection {
  readonly declaringClass: string;
  readonly field: string;
  readonly reason: string;
  /** The use that rules the layout out, when it is one site. */
  readonly loc?: SrcLoc;
  /** The use is a dynamic view of an instance: the field keeps the
   * contract's other rules and only the layout is ruled out. */
  readonly ordinary?: true;
}

export interface InlineArrayPlan {
  /** By class name, for the declaring classes and their subclasses. */
  readonly classes: ReadonlyMap<string, InlineArrayClass>;
  readonly rejected: readonly InlineArrayRejection[];
  /** The boxings of instances of planned hierarchies (or of values that can
   * hold one) whose dynamic values inline-array-views.ts follows: generic
   * code reads no member of theirs by an unknown name. */
  readonly viewed: ReadonlySet<IrExpr>;
}

export const NO_INLINE_ARRAYS: InlineArrayPlan = {
  classes: new Map(),
  rejected: [],
  viewed: new Set(),
};

/** The entries of `IrContracts.inlineArrays` (`${class}\0${field}`) whose
 * hierarchies the IR admits, given which element classes the backend can
 * store as 32-bit region references (`compactElem`). */
export function planInlineArrays(
  mod: IrModule,
  compactElem: (className: string) => boolean,
): InlineArrayPlan {
  const entries = mod.contracts?.inlineArrays ?? [];
  if (entries.length === 0) return NO_INLINE_ARRAYS;
  const classes = new Map<string, IrClassDef>();
  const children = new Map<string, string[]>();
  for (const cls of mod.classes ?? []) {
    classes.set(cls.name, cls);
    if (cls.base !== undefined) {
      const list = children.get(cls.base);
      if (list === undefined) children.set(cls.base, [cls.name]);
      else list.push(cls.name);
    }
  }
  const functions = new Map<string, IrFunction>();
  for (const fn of mod.functions) functions.set(fn.name, fn);
  const planned = new Map<string, InlineArrayClass>();
  const rejected: InlineArrayRejection[] = [];
  const viewed = new Set<IrExpr>();
  for (const entry of entries) {
    const at = entry.indexOf("\0");
    const declaringClass = entry.slice(0, at);
    const field = entry.slice(at + 1);
    const reject = (reason: string, loc?: SrcLoc, ordinary?: true): void => {
      rejected.push({
        declaringClass,
        field,
        reason,
        ...(loc !== undefined ? { loc } : {}),
        ...(ordinary ? { ordinary } : {}),
      });
    };
    const decl = classes.get(declaringClass);
    if (decl === undefined) {
      reject("the class is not in the program");
      continue;
    }
    const fieldIndex = decl.fields.findIndex((f) => f.name === field);
    if (fieldIndex < 0) {
      reject("the class has no such field");
      continue;
    }
    const base = decl.base === undefined ? undefined : classes.get(decl.base);
    if (base !== undefined && base.fields.some((f) => f.name === field)) {
      reject("the field is declared by a base class");
      continue;
    }
    const type = decl.fields[fieldIndex]!.type;
    if (type.kind !== "array" || type.elem.kind !== "object" || !compactElem(type.elem.className)) {
      reject("the field's elements are not ProgramLifetime instances");
      continue;
    }
    const elemClass = type.elem.className;
    // The subtree, preorder.
    const subtree: string[] = [];
    const collect = (name: string): void => {
      subtree.push(name);
      for (const child of children.get(name) ?? []) collect(child);
    };
    collect(declaringClass);
    const members = new Set(subtree);
    const lengthParams = new Map<string, number>();
    let reason: string | null = null;
    for (const name of subtree) {
      const ctor = functions.get(`%${name}.constructor`);
      if (ctor === undefined) {
        reason = `${name} has no constructor`;
        break;
      }
      const param =
        name === declaringClass
          ? writtenParam(ctor, members, field)
          : forwardedParam(ctor, classes.get(name)!.base!, lengthParams);
      if (typeof param === "string") {
        reason = `${name}: ${param}`;
        break;
      }
      lengthParams.set(name, param);
    }
    const other = reason === null ? otherUses(mod, members, field, declaringClass, viewed) : null;
    if (reason !== null || other !== null) {
      reject(reason ?? other!.reason, other?.loc, other?.ordinary);
      continue;
    }
    for (const name of subtree)
      planned.set(name, {
        declaringClass,
        field,
        fieldIndex,
        elemClass,
        lengthArg: lengthParams.get(name)! - 1,
      });
  }
  return { classes: planned, rejected, viewed };
}

/** The index in `ctor.params` (0 is `this`) of the parameter the declaring
 * constructor writes the field from, or why there is none. */
function writtenParam(
  ctor: IrFunction,
  members: ReadonlySet<string>,
  field: string,
): number | string {
  const self = ctor.params[0]?.localId;
  const writes: (IrStmt & { kind: "fieldSet" })[] = [];
  everyStmtList(ctor.body, {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "fieldSet" && s.field === field && members.has(s.className)) writes.push(s);
      return true;
    },
  });
  if (writes.length !== 1) return `the constructor writes the field ${writes.length} times`;
  const write = writes[0]!;
  // The write is one of the body's own statements: it runs exactly once.
  if (!ctor.body.includes(write)) return "the constructor writes the field conditionally";
  if (write.obj.kind !== "varRef" || write.obj.localId !== self)
    return "the constructor writes the field of another object";
  return parameterOf(ctor, write.value);
}

/** The index in `ctor.params` of the parameter a subclass constructor
 * passes to its base's at the base's length parameter, or why there is none. */
function forwardedParam(
  ctor: IrFunction,
  base: string,
  lengthParams: ReadonlyMap<string, number>,
): number | string {
  const baseParam = lengthParams.get(base);
  if (baseParam === undefined) return "its base class is not planned";
  const calls: (IrExpr & { kind: "call" })[] = [];
  everyStmtList(ctor.body, {
    expr: (e) => {
      if (e.kind === "call" && e.callee === `%${base}.constructor`) calls.push(e);
      return true;
    },
    stmt: () => true,
  });
  if (calls.length !== 1) return `the constructor calls its base's ${calls.length} times`;
  const arg = calls[0]!.args[baseParam];
  if (arg === undefined) return "the base constructor call has no argument for the field";
  return parameterOf(ctor, arg);
}

/** The index in `fn.params` of the parameter `value` reads, when the
 * parameter is never written; otherwise why it is not one. */
function parameterOf(fn: IrFunction, value: IrExpr): number | string {
  if (value.kind !== "varRef") return "the field's value is not a constructor parameter";
  const index = fn.params.findIndex((p, i) => i > 0 && p.localId === value.localId);
  if (index < 0) return "the field's value is not a constructor parameter";
  const local = fn.locals.find((l) => l.id === value.localId);
  if (local === undefined || local.boxed === true || assigns(fn, value.localId))
    return "the constructor parameter is written";
  // The allocation took its length from the argument, so nothing in the
  // constructor may change the array first: the field's value is the
  // parameter's only use.
  if (reads(fn, value.localId) !== 1)
    return "the constructor uses the array parameter besides storing it in the field";
  return index;
}

function reads(fn: IrFunction, localId: string): number {
  let n = 0;
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "varRef" && e.localId === localId) n++;
      return true;
    },
    stmt: () => true,
  });
  return n;
}

function assigns(fn: IrFunction, localId: string): boolean {
  return !everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => !(s.kind === "assign" && s.localId === localId),
  });
}

/** Why the rest of the program rules out the layout: another write of the
 * field, construction through a class value, an instance of the subtree
 * crossing into dynamic values (whose views of an instance read its fields
 * by name), or a read of the field compared by identity. Null when nothing
 * does. */
function otherUses(
  mod: IrModule,
  members: ReadonlySet<string>,
  field: string,
  declaringClass: string,
  viewed: Set<IrExpr>,
): { reason: string; loc?: SrcLoc; ordinary?: true } | null {
  const reaches = holdersOf(mod, members, declaringClass);
  // A boxed function exposes only its results: its arguments come back
  // through checked casts.
  const boxesHolder = (type: IrType): boolean =>
    type.kind === "func" ? reaches(type.ret) : reaches(type);
  // The dynamic values that may hold an instance (inline-array-views.ts).
  const boxings = new Set<IrExpr>();
  let reason: string | null = null;
  // Dynamic values that printing, JSON.stringify without a replacer and
  // publishing only read, and the options a worker copies its data from.
  const readOnly = new Set<IrExpr>();
  for (const fn of mod.functions) {
    const isDeclaringCtor = fn.name === `%${declaringClass}.constructor`;
    everyStmtList(fn.body, {
      expr: (e) => {
        if (reason !== null) return false;
        if (e.kind === "classRef" && members.has(e.className))
          reason = `${e.className} is used as a value`;
        else if (
          (e.kind === "libCall" && (readsArguments(e) || e.fn === "worker.new")) ||
          (e.kind === "intrinsic" &&
            (e.name.startsWith("console.") || e.name === "threads.publish"))
        )
          for (const a of e.args) readOnly.add(a);
        else if (
          (e.kind === "dynFrom" || e.kind === "caughtToDyn") &&
          !readOnly.has(e) &&
          boxesHolder(e.value.type)
        ) {
          // Normalization reboxes the instance its argument holds.
          if (fn.name !== NORMALIZE) boxings.add(e);
        } else if (e.kind === "fieldIncDec" && e.field === field && members.has(e.className))
          reason = "the field is written outside the constructor";
        else if (
          e.kind === "bin" &&
          (e.op === "===" || e.op === "!==") &&
          (readsField(e.left, members, field) || readsField(e.right, members, field))
        )
          reason =
            "the field is compared by identity, and each read of the field may give another array (compare a copy made with slice(), or compare the elements)";
        return reason === null;
      },
      stmt: (s) => {
        if (reason !== null) return false;
        if (
          s.kind === "fieldSet" &&
          s.field === field &&
          members.has(s.className) &&
          !isDeclaringCtor
        )
          reason = "the field is written outside the constructor";
        return reason === null;
      },
    });
    if (reason !== null) return { reason };
  }
  const issue = inlineArrayViewIssue(mod, boxings, field);
  if (issue === null) for (const e of boxings) viewed.add(e);
  return issue === null ? null : { ...issue, ordinary: true };
}

/** Whether values of a type may be, or hold, an instance of `members`
 * (the subtree of `declaringClass`): a value typed as a member or as a base
 * of the declaring class, or a class instance, record, union, array, Map or
 * Set whose fields or elements may hold one. A dynamic view of any of them
 * reads the instance's fields by name. */
function holdersOf(
  mod: IrModule,
  members: ReadonlySet<string>,
  declaringClass: string,
): (type: IrType) => boolean {
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const arms = new Map((mod.unions ?? []).map((u) => [u.id, u.arms]));
  const records = new Map((mod.records ?? []).map((r) => [r.id, r.fields]));
  const holderClasses = new Set(members);
  const holderShapes = new Set<string>();
  const addWithBases = (name: string): boolean => {
    let added = false;
    for (let at: string | undefined = name; at !== undefined; at = classes.get(at)?.base)
      if (!holderClasses.has(at)) {
        holderClasses.add(at);
        added = true;
      }
    return added;
  };
  addWithBases(declaringClass);
  const holds = (type: IrType): boolean => {
    const seen = new Set<string>();
    let found = false;
    const visit = (t: IrType): boolean => {
      if (t.kind === "object") found = holderClasses.has(t.className);
      else if (t.kind === "record") found = holderShapes.has(t.shapeId);
      else if (t.kind === "union" && !seen.has(t.unionId)) {
        seen.add(t.unionId);
        for (const arm of arms.get(t.unionId) ?? []) if (!visit(arm)) break;
      }
      return !found && everyTypeChild(t, visit);
    };
    visit(type);
    return found;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const cls of mod.classes ?? [])
      if (!holderClasses.has(cls.name) && cls.fields.some((f) => holds(f.type)))
        changed = addWithBases(cls.name) || changed;
    for (const [shapeId, fields] of records)
      if (!holderShapes.has(shapeId) && fields.some((f) => holds(f.type))) {
        holderShapes.add(shapeId);
        changed = true;
      }
  }
  return holds;
}

/** Library calls that only read their arguments: printing, inspection,
 * and JSON.stringify without a replacer function. */
export function readsArguments(e: IrExpr & { kind: "libCall" }): boolean {
  if (/^(console|insp|inspect)\./.test(e.fn)) return true;
  switch (e.fn) {
    case "array.hasProperties":
    case "array.hasNamedKey":
    case "array.namedKeys":
    case "json.stringifyValue":
      return true;
    case "json.stringifyReplacer": {
      const replacer = e.args[1];
      return replacer?.kind === "dynFrom" && replacer.value.kind === "unitLit";
    }
    default:
      return false;
  }
}

function readsField(e: IrExpr, members: ReadonlySet<string>, field: string): boolean {
  return e.kind === "fieldGet" && e.field === field && members.has(e.className);
}

/** Prepares the reads and constructions of planned classes (see the module
 * comment). Returns the module itself when nothing changes. */
export function inlineArrayReads(mod: IrModule, plan: InlineArrayPlan): IrModule {
  if (plan.classes.size === 0) return mod;
  const readers = new Map<string, IrFunction>();
  for (const fn of mod.functions) if (fn.name.startsWith(INDEX_READER)) readers.set(fn.name, fn);
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const next = rewriteFunction(fn, plan, readers);
    if (next !== fn) changed = true;
    return next;
  });
  return changed ? { ...mod, functions } : mod;
}

/** The lowering's checked element reads, `a[i]` as `T | undefined`
 * (array-values.ts): `(a, i) => a's element at i, or undefined`. */
const INDEX_READER = "%arr.idxOr.";

/** `call` of an element reader as the reader's own expression over the
 * call's array and index, so that a read of an inline field there reads the
 * instance: the index evaluates once, into a local unless it is a local or
 * a constant, and then after the instance the field is read off, which goes
 * into a local first. Null when the reader is not one returned expression. */
function inlineIndexRead(
  call: IrExpr & { kind: "call" },
  reader: IrFunction,
  fresh: (name: string, type: IrType) => string,
): IrExpr | null {
  const [arr, index] = call.args;
  const ret = reader.body.length === 1 ? reader.body[0] : undefined;
  const [arrParam, indexParam] = reader.params;
  if (
    arr === undefined ||
    index === undefined ||
    ret?.kind !== "return" ||
    ret.value === null ||
    arrParam === undefined ||
    indexParam === undefined
  )
    return null;
  const stmts: IrStmt[] = [];
  let array = arr;
  let at = index;
  if (index.kind !== "varRef" && !isConstant(index)) {
    // The call reads the array before the index, which may assign the
    // local the field is read off: the instance goes into a local first.
    if (arr.kind === "fieldGet" && arr.obj.kind === "varRef") {
      const owner = fresh("owner", arr.obj.type);
      stmts.push({ kind: "varDecl", localId: owner, init: arr.obj, loc: arr.loc });
      array = { ...arr, obj: { ...arr.obj, localId: owner } };
    }
    const id = fresh("index", index.type);
    stmts.push({ kind: "varDecl", localId: id, init: index, loc: index.loc });
    at = { kind: "varRef", localId: id, type: index.type, loc: index.loc };
  }
  // Each use gets its own copy: the array is a local or a field read off
  // one, the index a local or a constant.
  const copy = (e: IrExpr): IrExpr =>
    e.kind === "fieldGet" ? { ...e, obj: { ...e.obj } } : { ...e };
  const value = transformExpr(ret.value, {
    expr: (e) =>
      e.kind !== "varRef"
        ? e
        : e.localId === arrParam.localId
          ? copy(array)
          : e.localId === indexParam.localId
            ? copy(at)
            : e,
    stmt: (s) => s,
  });
  return stmts.length === 0
    ? value
    : { kind: "seqExpr", stmts, result: value, type: call.type, loc: call.loc };
}

function isInlineFieldRead(e: IrExpr, plan: InlineArrayPlan): e is IrExpr & { kind: "fieldGet" } {
  if (e.kind !== "fieldGet") return false;
  const cls = plan.classes.get(e.className);
  return cls !== undefined && cls.field === e.field;
}

/** Whether `parent` uses its child `child` (an array value) only by indexing
 * it, reading its length or iterating it. */
function isDirectUse(parent: IrExpr | IrStmt, child: IrExpr): boolean {
  // Element reads and presence tests (a for...of over an array that may
  // have holes tests each index first).
  if (parent.kind === "arrayGet" || parent.kind === "arrayHas" || parent.kind === "arrayState")
    return parent.arr === child;
  if (parent.kind === "arrIntrinsic")
    return parent.method === "length" && parent.receiver === child;
  if (parent.kind === "forOf") return parent.iterable === child;
  if (parent.kind === "call")
    return parent.callee.startsWith(INDEX_READER) && parent.args[0] === child;
  return false;
}

function rewriteFunction(
  fn: IrFunction,
  plan: InlineArrayPlan,
  readers: ReadonlyMap<string, IrFunction>,
): IrFunction {
  const locals = new Map<string, IrLocal>();
  for (const l of fn.locals) locals.set(l.id, l);
  // Aliases: immutable locals declared once from an inline field read, and
  // copies, immutable locals declared once from an alias (a `for...of` over
  // an alias iterates a copy of it).
  const declared = new Map<string, number>();
  const aliasDecl = new Map<string, IrStmt & { kind: "varDecl" }>();
  const copyOf = new Map<string, string>();
  const immutable = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.mutable && local.boxed !== true;
  };
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "varDecl") {
        declared.set(s.localId, (declared.get(s.localId) ?? 0) + 1);
        if (s.init !== null && immutable(s.localId)) {
          if (isInlineFieldRead(s.init, plan)) aliasDecl.set(s.localId, s);
          else if (s.init.kind === "varRef") copyOf.set(s.localId, s.init.localId);
        }
      }
      return true;
    },
  });
  for (const id of [...aliasDecl.keys()]) if (declared.get(id) !== 1) aliasDecl.delete(id);
  const isAlias = (id: string): boolean => aliasDecl.has(id) || copyOf.has(id);
  // A copy's source is an alias; each copy is declared once.
  for (let removed = true; removed;) {
    removed = false;
    for (const [id, source] of copyOf)
      if (declared.get(id) !== 1 || !isAlias(source)) {
        copyOf.delete(id);
        removed = true;
      }
  }
  // Every read of an alias must be a direct use, or a copy's declaration.
  if (aliasDecl.size > 0) {
    for (let removed = true; removed;) {
      removed = false;
      const direct = new Map<string, boolean>();
      const visitChildren = (parent: IrExpr | IrStmt, children: IrExpr[]): void => {
        for (const c of children)
          if (
            c.kind === "varRef" &&
            isAlias(c.localId) &&
            !isDirectUse(parent, c) &&
            !(parent.kind === "varDecl" && copyOf.get(parent.localId) === c.localId)
          )
            direct.set(c.localId, false);
      };
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "varRef") {
            if (isAlias(e.localId) && !direct.has(e.localId)) direct.set(e.localId, true);
            return true;
          }
          visitChildren(e, directChildren(e));
          return true;
        },
        stmt: (s) => {
          visitChildren(s, directStmtChildren(s));
          return true;
        },
      });
      const drop = (id: string): void => {
        if (aliasDecl.delete(id) || copyOf.delete(id)) removed = true;
      };
      for (const [id, ok] of direct) if (!ok) drop(id);
      for (const id of [...aliasDecl.keys(), ...copyOf.keys()]) if (!direct.has(id)) drop(id);
      // A copy of a dropped alias is none; a dropped copy's declaration
      // reads its source as an array, which the next pass finds.
      for (let more = true; more;) {
        more = false;
        for (const [id, source] of copyOf)
          if (!isAlias(source)) {
            copyOf.delete(id);
            more = removed = true;
          }
      }
    }
  } else copyOf.clear();
  /** The alias a copy copies. */
  const rootOf = (id: string): string => {
    let at = id;
    for (let source = copyOf.get(at); source !== undefined; source = copyOf.get(at)) at = source;
    return at;
  };
  const needsNew = !everyStmtList(fn.body, {
    expr: (e) => !(e.kind === "new" && newNeedsLocals(e, plan)),
    stmt: () => true,
  });
  // An element reader applied to an alias, or to a read of the field off a
  // local, reads the instance.
  const readsInline = (e: IrExpr): e is IrExpr & { kind: "call" } =>
    e.kind === "call" &&
    readers.has(e.callee) &&
    e.args.length === 2 &&
    ((e.args[0]!.kind === "varRef" && isAlias(e.args[0]!.localId)) ||
      (isInlineFieldRead(e.args[0]!, plan) && e.args[0]!.obj.kind === "varRef"));
  const needsReads = !everyStmtList(fn.body, { expr: (e) => !readsInline(e), stmt: () => true });
  if (aliasDecl.size === 0 && !needsNew && !needsReads) return fn;
  const newLocals: IrLocal[] = [];
  let counter = 0;
  const fresh = (name: string, type: IrType): string => {
    let id: string;
    do id = `%inl.${name}.${counter++}`;
    while (locals.has(id));
    const local: IrLocal = { id, name: `%inl.${name}`, type, mutable: false };
    locals.set(id, local);
    newLocals.push(local);
    return id;
  };
  // Each alias reads the field through a local holding the instance: the
  // instance expression's own local when it is an immutable one, else a new
  // one the declaration initializes.
  const owners = new Map<string, { localId: string; read: IrExpr & { kind: "fieldGet" } }>();
  for (const [id, decl] of aliasDecl) {
    const read = decl.init as IrExpr & { kind: "fieldGet" };
    const obj = read.obj;
    const own = obj.kind === "varRef" ? locals.get(obj.localId) : undefined;
    const ownerId =
      own !== undefined && !own.mutable && own.boxed !== true && !assigns(fn, own.id)
        ? own.id
        : fresh("owner", obj.type);
    owners.set(id, { localId: ownerId, read });
  }
  const fieldRead = (aliasId: string, loc: SrcLoc): IrExpr => {
    const owner = owners.get(aliasId)!;
    return {
      ...owner.read,
      obj: { kind: "varRef", localId: owner.localId, type: owner.read.obj.type, loc },
      loc,
    };
  };
  const body = transformStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "varRef" && isAlias(e.localId)) return fieldRead(rootOf(e.localId), e.loc);
      if (e.kind === "new" && newNeedsLocals(e, plan)) return newThroughLocals(e, fresh);
      if (readsInline(e)) return inlineIndexRead(e, readers.get(e.callee)!, fresh) ?? e;
      return e;
    },
    stmt: (s) => {
      // A copy's declaration goes: its reads read the field.
      if (s.kind === "varDecl" && copyOf.has(s.localId))
        return { kind: "block", body: [], loc: s.loc };
      if (s.kind === "varDecl" && owners.has(s.localId)) {
        const owner = owners.get(s.localId)!;
        const obj = owner.read.obj;
        // The instance's own local needs no declaration; otherwise the
        // alias's declaration becomes the owner's.
        if (obj.kind === "varRef" && obj.localId === owner.localId)
          return { kind: "block", body: [], loc: s.loc };
        return { kind: "varDecl", localId: owner.localId, init: obj, loc: s.loc };
      }
      return s;
    },
  });
  return { ...fn, body, locals: [...fn.locals, ...newLocals] };
}

/** A `new` of a planned class whose length argument is not a local read. */
function newNeedsLocals(e: IrExpr & { kind: "new" }, plan: InlineArrayPlan): boolean {
  if (!plan.classes.has(e.className)) return false;
  // The allocation reads the length once every argument has run: unless
  // they are all locals and constants, which run no code, they are
  // evaluated into locals first.
  return !e.args.every((a) => a.kind === "varRef" || isConstant(a));
}

function isConstant(e: IrExpr): boolean {
  return e.kind === "numLit" || e.kind === "strLit" || e.kind === "boolLit" || e.kind === "unitLit";
}

/** `new C(a, b, ...)` as `(t0 = a, t1 = b, ..., new C(t0, t1, ...))`: the
 * arguments evaluate in order before the allocation. */
function newThroughLocals(
  e: IrExpr & { kind: "new" },
  fresh: (name: string, type: IrType) => string,
): IrExpr {
  const stmts: IrStmt[] = [];
  const args = e.args.map((a) => {
    const id = fresh("arg", a.type);
    stmts.push({ kind: "varDecl", localId: id, init: a, loc: a.loc });
    return { kind: "varRef", localId: id, type: a.type, loc: a.loc } as IrExpr;
  });
  return { kind: "seqExpr", stmts, result: { ...e, args }, type: e.type, loc: e.loc } as IrExpr;
}

/** The expression children of `e` that are array operands the alias test
 * looks at (everything else that reads an alias makes it escape). */
function directChildren(e: IrExpr): IrExpr[] {
  const out: IrExpr[] = [];
  everyExprChildList(e, out);
  return out;
}

function directStmtChildren(s: IrStmt): IrExpr[] {
  const out: IrExpr[] = [];
  everyStmtChildList(s, out);
  return out;
}

// Immediate expression children, through the generic traversal: a child
// visitor that collects instead of recursing.
function everyExprChildList(e: IrExpr, out: IrExpr[]): void {
  everyExprChild(
    e,
    (c) => {
      out.push(c);
      return true;
    },
    () => true,
  );
}

function everyStmtChildList(s: IrStmt, out: IrExpr[]): void {
  everyStmtChild(
    s,
    (c) => {
      out.push(c);
      return true;
    },
    () => true,
  );
}
