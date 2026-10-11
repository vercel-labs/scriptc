import { isRefCounted, type IrClassDef, type IrExpr, type IrModule, type IrStmt } from "./ir.js";
import { dynamicFieldStores } from "./int32-slots.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** Whole-program final reference fields.
 *
 * A reference-counted class field is final when every write the program can
 * make to it is a constructor of its family storing through that
 * constructor's own `this`. Outside the constructors such a field never
 * changes, so while its object is alive the field keeps its value alive: a
 * read of `o.f` may be borrowed for as long as `o` itself is (`this.scanner`
 * inside a method, across any call), without a retain and a release.
 * Constructors are excluded from that use, because they are where the field
 * changes; so are async functions and generators, whose suspensions let
 * other code (a constructor that is still running) continue.
 *
 * Writes the IR does not show disqualify fields up front: library builds
 * (instances cross a native boundary), live dynamic views whose stores can
 * name the field (see dynamicFieldStores), and classes with runtime-provided
 * or generic ancestors. Generated stores only initialize fresh objects or
 * tear down dead ones. */
export class FinalFields {
  private readonly finals = new Set<string>();
  private readonly familyOf = new Map<string, string | null>();
  /** Disqualified families and the first reason, for tests. */
  readonly reasons = new Map<string, string>();

  constructor(private readonly classes: ReadonlyMap<string, IrClassDef> = new Map()) {}

  /** The topmost class in the base chain declaring the field, and the field. */
  family(className: string, field: string): string | null {
    const key = `${className}\0${field}`;
    const cached = this.familyOf.get(key);
    if (cached !== undefined) return cached;
    let owner: IrClassDef | undefined = this.classes.get(className);
    let result: string | null = null;
    if (owner?.fields.some((f) => f.name === field)) {
      for (;;) {
        const base: IrClassDef | undefined = owner.base ? this.classes.get(owner.base) : undefined;
        if (!base?.fields.some((f) => f.name === field)) break;
        owner = base;
      }
      result = `${owner.name}\0${field}`;
    }
    this.familyOf.set(key, result);
    return result;
  }

  isFinal(className: string, field: string): boolean {
    if (this.finals.size === 0) return false;
    const family = this.family(className, field);
    return family !== null && this.finals.has(family);
  }

  get size(): number {
    return this.finals.size;
  }

  /* ── construction (analyzeFinalFields only) ── */
  add(family: string): void {
    this.finals.add(family);
  }
  drop(family: string, why: string): void {
    if (!this.reasons.has(family)) this.reasons.set(family, why);
    this.finals.delete(family);
  }
}

const CONSTRUCTOR_SUFFIX = ".constructor";

/** `%C.constructor`'s class name, or null for any other function. */
export function constructorClass(fnName: string): string | null {
  return fnName.startsWith("%") && fnName.endsWith(CONSTRUCTOR_SUFFIX)
    ? fnName.slice(1, -CONSTRUCTOR_SUFFIX.length)
    : null;
}

export function analyzeFinalFields(mod: IrModule): FinalFields {
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const finals = new FinalFields(classes);
  if (mod.lib) return finals;
  const dynamic = dynamicFieldStores(mod);
  if (dynamic.all) return finals;

  const genericFamilies = new Set<string>();
  for (const cls of classes.values())
    if (cls.genericOf !== undefined) {
      genericFamilies.add(cls.name);
      genericFamilies.add(cls.genericOf);
    }
  const plainClass = (cls: IrClassDef): boolean => {
    for (let c: IrClassDef | undefined = cls; c; c = c.base ? classes.get(c.base) : undefined) {
      if (c.runtime || genericFamilies.has(c.name)) return false;
      if (c.base && !classes.has(c.base)) return false;
    }
    return true;
  };
  const inFamily = (className: string, family: string): boolean => {
    const owner = family.slice(0, family.indexOf("\0"));
    for (let c = classes.get(className); c; c = c.base ? classes.get(c.base) : undefined)
      if (c.name === owner) return true;
    return false;
  };

  for (const cls of classes.values())
    for (const field of cls.fields) {
      if (!isRefCounted(field.type) || field.name.startsWith("%")) continue;
      const family = finals.family(cls.name, field.name)!;
      if (finals.reasons.has(family)) continue;
      if (!plainClass(cls)) finals.drop(family, "runtime-provided or generic class");
      else if (dynamic.names.has(field.name))
        finals.drop(family, "dynamic stores can name the field");
      else finals.add(family);
    }
  if (finals.size === 0) return finals;

  for (const fn of mod.functions) {
    const ctor = constructorClass(fn.name);
    const self = ctor !== null ? fn.params[0]?.localId : undefined;
    const selfLocal = self !== undefined ? fn.locals.find((l) => l.id === self) : undefined;
    // `this` must name the object under construction for the whole body.
    const constructing = selfLocal !== undefined && !selfLocal.boxed && !reassigns(fn.body, self!);
    const stmt = (s: IrStmt): boolean => {
      if (s.kind === "fieldSet") {
        const family = finals.family(s.className, s.field);
        if (family !== null && finals.isFinal(s.className, s.field)) {
          const own =
            constructing && ctor !== null && inFamily(ctor, family) && isSelf(s.obj, self!);
          if (!own) finals.drop(family, `written in ${fn.name}`);
        }
      }
      return everyStmtChild(s, expr, stmt);
    };
    const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
    for (const s of fn.body) stmt(s);
  }
  return finals;
}

/** `this` itself, or behind the derived constructor's guards (`if (!super
 * called) throw`), which read no reference and write nothing. */
function isSelf(e: IrExpr, self: string): boolean {
  if (e.kind === "varRef") return e.localId === self;
  if (e.kind !== "seqExpr") return false;
  for (const s of e.stmts) {
    if (s.kind !== "if" || s.else_ !== null || s.then.length !== 1) return false;
    const only = s.then[0]!;
    if (
      only.kind !== "exprStmt" ||
      only.expr.kind !== "libCall" ||
      only.expr.fn !== "error.nodeThrow" ||
      !only.expr.args.every((arg) => arg.kind === "numLit" || arg.kind === "strLit") ||
      !throwFreeCondition(s.cond)
    )
      return false;
  }
  return isSelf(e.result, self);
}

function throwFreeCondition(e: IrExpr): boolean {
  if (e.kind === "varRef" || e.kind === "boolLit") return e.type.kind === "bool";
  return e.kind === "unary" && throwFreeCondition(e.operand);
}

function reassigns(body: IrStmt[], localId: string): boolean {
  let found = false;
  const expr = (e: IrExpr): boolean => {
    if ((e.kind === "assignExpr" || e.kind === "incDec") && e.localId === localId) found = true;
    return !found && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "assign" && s.localId === localId && s.initializes !== true) found = true;
    return !found && everyStmtChild(s, expr, stmt);
  };
  for (const s of body) if (!stmt(s)) break;
  return found;
}
