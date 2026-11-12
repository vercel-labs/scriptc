import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  canConvertToDyn,
  canDynCheckTo,
  DYN,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import {
  classMemberNameOf,
  classValueRef,
  findStaticAccessorOn,
  type ClassInfo,
} from "./lower-classes.js";
import { classPrototypeData } from "./class-prototypes.js";
import {
  reflectedClassStaticMethodValueForTable,
  staticTableMemberRefused,
} from "./class-method-values.js";

/** A class whose constructor value the program turns into a checked-dynamic
 * value needs a property table on its class object: a keyed read through
 * `any`, `Reflect.get`, `Object.getOwnPropertyDescriptor` and `in` all answer
 * from it at run time. The compiler lowers the table's contents at the class
 * statement, where JavaScript defines the statics, so this module builds one
 * installer function per class and the call that runs it in the declaring
 * file's %init.
 *
 * Only classes that can be represented exactly are installed: a class with a
 * static the table cannot answer (an accessor or method whose body needs a
 * native receiver, a symbol-keyed or run-time-keyed member, a base that is
 * not a program class) keeps the runtime's SC1090 fence instead, because a
 * table that answered part of a class would report a member it does not hold
 * as `undefined`. */

const shapesOf = (lowerer: Lowerer) => (id: string) => lowerer.shapes.get(id);
const unionsOf = (lowerer: Lowerer) => (id: string) => lowerer.unions.get(id);

/** Whether `info` and every class above it can carry a complete table. The
 * class graph does not change once lowering starts, so the answer is fixed. */
export function classStaticsRepresentable(lowerer: Lowerer, info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base)
    if (!ownStaticsRepresentable(lowerer, current)) return false;
  return true;
}

/** Whether every class value the program can store where a `typeof C` is
 * expected carries a complete table: `info` and each program subclass of it.
 * A read whose static type no longer names the member (`(C as any).x`) has
 * only the run-time class to answer it, so it takes the table path exactly
 * when this holds. */
export function classStaticsSubtreeReadable(lowerer: Lowerer, info: ClassInfo): boolean {
  if (!classStaticsRepresentable(lowerer, info)) return false;
  for (const other of lowerer.classes.values())
    if (
      other.def.name !== info.def.name &&
      lowerer.isSubclassOf(other.def.name, info.def.name) &&
      !classStaticsRepresentable(lowerer, other)
    )
      return false;
  return true;
}

function ownStaticsRepresentable(lowerer: Lowerer, info: ClassInfo): boolean {
  const decl = info.decl;
  if (!decl || !ts.isClassDeclaration(decl)) return false;
  if (
    info.localClass !== undefined ||
    info.generic !== undefined ||
    info.genericInstance !== undefined ||
    info.mixinInstance !== undefined ||
    info.callableBase !== undefined ||
    info.extendsDate !== undefined ||
    info.def.runtime === true ||
    info.def.baseValueGlobal !== undefined ||
    info.builtinError === true ||
    info.builtinEmitter === true ||
    info.builtinStream !== undefined ||
    info.builtinEventTarget !== undefined ||
    info.runtimeStatics !== undefined ||
    info.runtimePrototypeMembers !== undefined ||
    info.hasInstanceHook === true
  )
    return false;
  for (const member of decl.members.nodes) {
    const staticMember =
      ts.canHaveModifiers(member) === true &&
      ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
        true;
    if (!staticMember) continue;
    const name = (member as { name?: ts.PropertyName }).name;
    if (name === undefined) continue;
    if (ts.isComputedPropertyName(name)) {
      // A symbol or run-time key defines a property no source name reads,
      // and the table could not list it: reflectively it would go missing.
      if (classMemberNameOf(lowerer, name) === null) return false;
      continue;
    }
    if (ts.isPrivateIdentifier(name))
      // A private static is not a public key: the table never lists it
      // (reflection must not enumerate or reach its storage), and its
      // presence does not make the class's public statics ineligible.
      continue;
    const text = classMemberNameOf(lowerer, name);
    if (text === null) return false;
    if (ts.isAccessor(member)) {
      // An accessor half whose signature did not collect has no value form.
      if (!findStaticAccessorOn(info, text)) return false;
      // A body that needs the native class cannot run over the dynamic
      // receiver the table passes.
      if (staticTableMemberRefused(lowerer, info, member)) return false;
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      // An initializer-less field defines an own data property whose value
      // is `undefined`; the installer defines it, so it is representable.
      if (member.initializer === undefined) continue;
      const field = info.staticFields.find((candidate) => candidate.name === text);
      if (!field) return false;
      if (!canConvertToDyn(field.type, shapesOf(lowerer), unionsOf(lowerer))) return false;
      if (!canDynCheckTo(field.type, shapesOf(lowerer), unionsOf(lowerer))) return false;
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      if (!info.staticMethods?.has(text)) return false;
      if (staticTableMemberRefused(lowerer, info, member)) return false;
    }
  }
  return true;
}

/** The lifted function that installs `info`'s static table on the class
 * value it receives: the class's property table linked to its base's, with
 * the class's own statics defined in JavaScript's own-key order (`length`
 * and `name` are the table's first entries, then `prototype`, then the
 * methods and accessors in declaration order, then the fields). Null when
 * the class has no prototype object to expose. */
export function classStaticsInstaller(
  lowerer: Lowerer,
  info: ClassInfo,
  loc: SrcLoc,
): IrFunction | null {
  const name = `%dyn.class.statics.${info.def.name}`;
  const existing = lowerer.liftedFnNamed(name);
  if (existing) return existing;
  const prototype = classPrototypeData(lowerer, info, loc);
  if (!prototype) return null;
  lowerer.shareHelper(name);
  const self = varRef("p.0", DYN, loc);
  const statements: IrStmt[] = [];
  const base = info.base
    ? lowerer.coerceToExpected(classValueRef(lowerer, info.base, info.decl!), DYN)
    : dynUndefinedExpr(loc);
  // The base's table is where an inherited name resolves; the link is what
  // makes `Object.getPrototypeOf(Sub)` the base class as well.
  statements.push({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "dyn.classInherit", args: [self, base], type: DYN, loc },
    loc,
  });
  const define = (key: string, descriptor: IrExpr, at: SrcLoc): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [
        self,
        lowerer.coerceToExpected({ kind: "strLit", value: key, type: STRING, loc: at }, DYN),
        descriptor,
      ],
      type: DYN,
      loc: at,
    },
    loc: at,
  });
  const descriptor = (entries: { key: string; value: IrExpr }[], at: SrcLoc): IrExpr => ({
    kind: "dynObjLit",
    fields: entries.map((entry) => ({
      key: { kind: "strLit", value: entry.key, type: STRING, loc: at },
      value: entry.value,
    })),
    type: DYN,
    loc: at,
  });
  const flag = (value: boolean, at: SrcLoc): IrExpr =>
    lowerer.coerceToExpected({ kind: "boolLit", value, type: BOOL, loc: at }, DYN);
  // `C.prototype` is own, and non-writable, non-enumerable, non-configurable.
  statements.push(
    define(
      "prototype",
      descriptor(
        [
          { key: "value", value: lowerer.coerceToExpected(prototype, DYN) },
          { key: "writable", value: flag(false, loc) },
          { key: "enumerable", value: flag(false, loc) },
          { key: "configurable", value: flag(false, loc) },
        ],
        loc,
      ),
      loc,
    ),
  );
  // Methods and accessors come first: ClassDefinitionEvaluation defines
  // every one of them before any static field initializer runs.
  const setters = new Set<string>();
  for (const member of info.decl!.members.nodes) {
    const propertyName = (member as { name?: ts.PropertyName }).name;
    if (propertyName === undefined || ts.isPrivateIdentifier(propertyName)) continue;
    const key = classMemberNameOf(lowerer, propertyName);
    if (key === null) continue;
    const at = locOf(member);
    if (ts.isMethodDeclaration(member)) {
      const value = reflectedClassStaticMethodValueForTable(lowerer, info, key);
      if (!value) continue;
      statements.push(
        define(
          key,
          descriptor(
            [
              { key: "value", value: lowerer.coerceToExpected(value, DYN) },
              { key: "writable", value: flag(true, at) },
              { key: "enumerable", value: flag(false, at) },
              { key: "configurable", value: flag(true, at) },
            ],
            at,
          ),
          at,
        ),
      );
      continue;
    }
    if (!ts.isAccessor(member) || setters.has(key)) continue;
    const getter = findStaticAccessorOn(info, key)?.get
      ? reflectedClassStaticMethodValueForTable(lowerer, info, `get:${key}`)
      : null;
    const setter = findStaticAccessorOn(info, key)?.set
      ? reflectedClassStaticMethodValueForTable(lowerer, info, `set:${key}`)
      : null;
    if (!getter && !setter) continue;
    const entries: { key: string; value: IrExpr }[] = [
      { key: "enumerable", value: flag(false, at) },
      { key: "configurable", value: flag(true, at) },
    ];
    if (getter) entries.unshift({ key: "get", value: lowerer.coerceToExpected(getter, DYN) });
    if (setter) entries.push({ key: "set", value: lowerer.coerceToExpected(setter, DYN) });
    statements.push(define(key, descriptor(entries, at), at));
    setters.add(key);
  }
  // Static fields are own data properties on the class object, in
  // declaration order: Node reports `{ value, writable: true,
  // enumerable: true, configurable: true }`, never an accessor. A field
  // without an initializer still defines the property, with the value
  // `undefined`, so `'name' in C` and the descriptor APIs see it. A
  // `#private` field is not a public key at all: it never enters the
  // table (the security contract — reflection must not reach its
  // storage), and the class's public statics still install around it.
  for (const member of info.decl!.members.nodes) {
    if (!ts.isPropertyDeclaration(member)) continue;
    const modifiers = ts.getModifiers(member);
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) continue;
    // `declare static x` is type-only: no runtime property.
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isPrivateIdentifier(member.name)) continue;
    const name = classMemberNameOf(lowerer, member.name);
    if (name === null) continue;
    const at = locOf(member);
    const field = info.staticFields.find((candidate) => candidate.name === name);
    const value =
      field === undefined
        ? dynUndefinedExpr(at)
        : lowerer.coerceToExpected(varRef(field.globalId, field.type, at), DYN);
    statements.push(
      define(
        name,
        descriptor(
          [
            { key: "value", value },
            { key: "writable", value: flag(true, at) },
            { key: "enumerable", value: flag(true, at) },
            { key: "configurable", value: flag(true, at) },
          ],
          at,
        ),
        at,
      ),
    );
  }
  const fn: IrFunction = {
    name,
    params: [{ localId: "p.0", name: "value", type: DYN }],
    returnType: VOID,
    locals: [{ id: "p.0", name: "value", type: DYN, mutable: false }],
    body: statements,
    loc,
  };
  lowerer.liftedFns.push(fn);
  return fn;
}

/** Inserts the install call at the class declaration's position in its
 * file's %init, where JavaScript evaluates the class: a read after the
 * statement sees the table, and a program that never boxes a class value
 * keeps its emitted IR. */
export function insertClassStaticsInstall(
  lowerer: Lowerer,
  info: ClassInfo,
  functions: readonly IrFunction[],
): boolean {
  const decl = info.decl;
  if (!decl) return false;
  const sf = ts.getSourceFileOfNode(decl);
  const initName = lowerer.initNameOf.get(sf);
  if (initName === undefined) return false;
  const init = functions.find((candidate) => candidate.name === initName);
  if (!init) return false;
  const loc = locOf(decl);
  const installer = classStaticsInstaller(lowerer, info, loc);
  if (!installer) return false;
  lowerer.noteEdge(installer.name);
  const call: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: installer.name,
      args: [lowerer.coerceToExpected(classValueRef(lowerer, info, decl), DYN)],
      type: VOID,
      loc,
    },
    loc,
  };
  const end = decl.end;
  const file = sf.fileName;
  let at = 0;
  for (let i = 0; i < init.body.length; i++) {
    const statement = init.body[i]!;
    if (statement.loc.file !== file || statement.loc.start >= end) continue;
    at = i + 1;
  }
  init.body.splice(at, 0, call);
  return true;
}
