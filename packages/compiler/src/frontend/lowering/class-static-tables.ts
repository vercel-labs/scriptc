import { varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import {
  classMemberNameOf,
  classValueRef,
  findStaticOn,
  staticMethodFunctionFor,
  type ClassInfo,
} from "./lower-classes.js";
import { hasRuntimeStatics } from "./class-runtime-statics.js";
import { reflectClassPrototype } from "./class-prototypes.js";

/** Whether the constructor of `info`, converted to a dynamic value, carries
 * a table of the class's static members (classStaticTable): a TypeScript
 * class declared at module level whose statics live in native storage, and
 * whose base classes are such classes too. Every other class value keeps
 * the answers it has (a JavaScript class's own table, or the run-time
 * refusal). */
function hasStaticTable(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (
      !current.decl ||
      isJsSourceFile(ts.getSourceFileOfNode(current.decl)) ||
      current.localClass ||
      hasRuntimeStatics(current) ||
      current.callableBase ||
      current.mixinInstance ||
      current.generic ||
      current.genericInstance ||
      current.classDecorators ||
      current.def.runtime ||
      current.builtinEmitter ||
      current.builtinStream ||
      current.builtinError
    )
      return false;
  }
  return true;
}

function isStatic(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
      true
  );
}

/** The helper that defines the static members of `info` and its `prototype`
 * in the table of its constructor seen as a dynamic value, creating it when
 * the class is one that carries the table. The runtime calls it once, on the
 * first conversion of the constructor (scr_dyn_class_statics_begin).
 *
 * The statics stay where typed code reads them. A static field is an
 * accessor pair over its module global that the table reports as the data
 * property it is; a write through the dynamic value is checked against the
 * field's type. A static method is the value of its module function. A
 * static accessor is that accessor. Private statics are not properties.
 * Inherited statics are read through the table of the base class, which the
 * constructor's table has as its prototype.
 *
 * A member with no lowering as a value answers with a named refusal when it
 * is read, never with undefined. */
export function classStaticTable(
  lowerer: Lowerer,
  info: ClassInfo,
  loc: SrcLoc,
): IrFunction | null {
  if (info.def.staticsHelper !== undefined) return lowerer.liftedFnNamed(info.def.staticsHelper)!;
  if (!hasStaticTable(info) || !info.decl) return null;
  const decl = info.decl;
  const className = info.def.name;
  const members: { name: string; node: ts.ClassElement }[] = [];
  for (const member of decl.members.nodes) {
    if (!isStatic(member) || ts.isClassStaticBlockDeclaration(member)) continue;
    const memberName = (member as { name?: ts.PropertyName }).name;
    if (memberName === undefined || ts.isPrivateIdentifier(memberName)) continue;
    const name = classMemberNameOf(lowerer, memberName);
    // A key decided at run time: the table cannot be completed.
    if (name === null || name.startsWith("sym:")) return null;
    members.push({ name, node: member });
  }
  const helperName = `%class.statics:${className}`;
  const lift = (suffix: string, params: IrType[], ret: IrType, body: IrStmt[]): IrExpr => {
    const name = `${helperName}.${suffix}`;
    const typed = params.map((type, i) => ({ localId: `p.${i}`, name: `p${i}`, type }));
    lowerer.liftedFns.push({
      name,
      params: typed,
      returnType: ret,
      locals: typed.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body,
      loc,
    });
    return {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params, ret },
      loc,
    };
  };
  const refusal = (suffix: string, what: string): IrExpr =>
    lift(suffix, [], DYN, [
      {
        kind: "runtimeFence",
        code: "SC1090",
        message: `${what} of a class read through a dynamic value is not supported yet`,
        loc,
      },
    ]);
  const dyn = (value: IrExpr): IrExpr => lowerer.coerceToExpected(value, DYN);
  const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
  const flag = (value: boolean): IrExpr => dyn({ kind: "boolLit", value, type: BOOL, loc });
  // Attempts a member's value; a refusal of its own lowering becomes the
  // run-time refusal of that member alone.
  const attempt = (build: () => IrExpr | null): IrExpr | null => {
    const before = lowerer.diags.length;
    try {
      return build();
    } catch (error) {
      if (!(error instanceof PoisonError)) throw error;
      lowerer.diags.splice(before);
      return null;
    }
  };
  const methodValue = (member: string): IrExpr | null =>
    attempt(() => {
      const target = staticMethodFunctionFor(lowerer, decl, info, member);
      if (!target) return null;
      if (!target.receiverDependent) lowerer.noteEdge(target.fn);
      const type: IrType = {
        kind: "func",
        params: target.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
        ret: target.ret,
        ...(target.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
      };
      if (!lowerer.dynConvertible(type)) return null;
      return { kind: "closure", fnName: target.fn, captures: [], type, loc };
    });

  const constructorLocal = "%constructor";
  const constructor = varRef(constructorLocal, DYN, loc);
  const body: IrStmt[] = [];
  const define = (key: string, fields: { key: string; value: IrExpr }[], native: boolean): void => {
    const defined: IrExpr = {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [
        constructor,
        dyn(text(key)),
        {
          kind: "dynObjLit",
          fields: fields.map((field) => ({ key: text(field.key), value: field.value })),
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    };
    body.push({ kind: "exprStmt", expr: defined, loc });
    if (native)
      body.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.classStaticSlot",
          args: [constructor, dyn(text(key))],
          type: DYN,
          loc,
        },
        loc,
      });
  };
  // `prototype`: the class's prototype object with its methods and
  // accessors, or the refusal of that object where it has no lowering.
  const definePrototype = (): void => {
    const prototype = attempt(() =>
      reflectClassPrototype(lowerer, info, loc, classValueRef(lowerer, info, decl)),
    );
    define(
      "prototype",
      prototype
        ? [
            { key: "value", value: prototype },
            { key: "writable", value: flag(false) },
            { key: "enumerable", value: flag(false) },
            { key: "configurable", value: flag(false) },
          ]
        : [
            { key: "get", value: dyn(refusal("prototype", "the prototype")) },
            { key: "enumerable", value: flag(false) },
            { key: "configurable", value: flag(false) },
          ],
      false,
    );
  };
  definePrototype();
  // Own keys in the order a class definition creates them: methods and
  // accessors as the class is defined, then the fields as they initialize.
  const ordered = [
    ...members.filter((member) => !ts.isPropertyDeclaration(member.node)),
    ...members.filter((member) => ts.isPropertyDeclaration(member.node)),
  ];
  const defined = new Set<string>();
  for (const { name, node } of ordered) {
    if (defined.has(name)) continue;
    defined.add(name);
    const suffix = `${defined.size}`;
    if (ts.isPropertyDeclaration(node)) {
      const found = findStaticOn(lowerer, info, name);
      const field = found?.declarer === info ? found.field : undefined;
      if (!field || !lowerer.dynConvertible(field.type)) {
        define(
          name,
          [
            { key: "get", value: dyn(refusal(`${suffix}.get`, `the static field '${name}'`)) },
            { key: "enumerable", value: flag(true) },
            { key: "configurable", value: flag(false) },
          ],
          false,
        );
        continue;
      }
      const get = lift(`${suffix}.get`, [], field.type, [
        { kind: "return", value: varRef(field.globalId, field.type, loc), loc },
      ]);
      const fields = [{ key: "get", value: dyn(get) }];
      if (!field.readonly)
        fields.push({
          key: "set",
          value: dyn(
            lift(`${suffix}.set`, [field.type], VOID, [
              {
                kind: "assign",
                localId: field.globalId,
                value: varRef("p.0", field.type, loc),
                loc,
              },
              { kind: "return", value: null, loc },
            ]),
          ),
        });
      fields.push(
        { key: "enumerable", value: flag(true) },
        { key: "configurable", value: flag(true) },
      );
      define(name, fields, true);
      continue;
    }
    if (ts.isAccessor(node)) {
      const get = methodValue(`get:${name}`);
      const set = methodValue(`set:${name}`);
      const declares = (getter: boolean): boolean =>
        members.some(
          (other) =>
            other.name === name &&
            (getter
              ? ts.isGetAccessorDeclaration(other.node)
              : ts.isSetAccessorDeclaration(other.node)),
        );
      const fields: { key: string; value: IrExpr }[] = [];
      if (declares(true))
        fields.push({
          key: "get",
          value: dyn(get ?? refusal(`${suffix}.get`, `the static getter '${name}'`)),
        });
      if (declares(false))
        fields.push({
          key: "set",
          value: dyn(set ?? refusal(`${suffix}.set`, `the static setter '${name}'`)),
        });
      fields.push(
        { key: "enumerable", value: flag(false) },
        { key: "configurable", value: flag(true) },
      );
      define(name, fields, false);
      continue;
    }
    const value = ts.isMethodDeclaration(node) ? methodValue(name) : null;
    if (value) {
      define(
        name,
        [
          { key: "value", value: dyn(value) },
          { key: "writable", value: flag(true) },
          { key: "enumerable", value: flag(false) },
          { key: "configurable", value: flag(true) },
        ],
        true,
      );
    } else {
      define(
        name,
        [
          { key: "get", value: dyn(refusal(`${suffix}.get`, `the static method '${name}'`)) },
          { key: "enumerable", value: flag(false) },
          { key: "configurable", value: flag(false) },
        ],
        false,
      );
    }
  }
  const base = info.base;
  const helper: IrFunction = {
    name: helperName,
    params: [],
    returnType: VOID,
    locals: [{ id: constructorLocal, name: "constructor", type: DYN, mutable: false }],
    body: [
      {
        kind: "varDecl",
        localId: constructorLocal,
        init: dyn(classValueRef(lowerer, info, decl)),
        loc,
      },
      // The table of the base class is this table's prototype.
      ...(base
        ? [
            {
              kind: "exprStmt" as const,
              expr: {
                kind: "libCall" as const,
                fn: "dyn.classInherit" as const,
                args: [constructor, dyn(classValueRef(lowerer, base, decl))],
                type: DYN,
                loc,
              },
              loc,
            },
          ]
        : []),
      ...body,
      { kind: "return", value: null, loc },
    ],
    loc,
  };
  lowerer.liftedFns.push(helper);
  info.def.staticsHelper = helperName;
  return helper;
}
