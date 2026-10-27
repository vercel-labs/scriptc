import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  CLASS_ATTRIBUTES,
  CLASS_FROZEN,
  CLASS_NOT_EXTENSIBLE,
  CLASS_SEALED,
  DYN,
  F64,
  FIELD_NOT_WRITABLE,
  STRING,
  VOID,
  canConvertToDyn,
  canDynCheckTo,
  classFieldAttributesName,
  isClassOwnEnumerableFieldName,
  isDynTypedRefType,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, strLit, varRef } from "../../ir/build.js";
import { transformStmtList } from "../../ir/traverse.js";
import { locOf } from "../program.js";
import { type Lowerer, PoisonError } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { classPropertiesHelper } from "./class-dynamic-dispatch.js";
import { runtimeRooted } from "./class-descriptors.js";

/* Object.freeze, Object.seal, Object.preventExtensions and
 * Object.defineProperty on class instances. Only the hierarchies these calls
 * name pay for them: such a hierarchy gets a CLASS_ATTRIBUTES integrity word
 * per instance, an attribute word per redefined field, and a check before
 * each write to a declared field (guardClassAttributeWrites). The instance's
 * checked view carries the attributes, so reflection answers from it. */

type ClassObjectType = Extract<IrType, { kind: "object" }>;

function attributeClass(lowerer: Lowerer, target: IrExpr): ClassInfo | null {
  return isDynTypedRefType(target.type)
    ? attributeClassNamed(lowerer, target.type.className)
    : null;
}

/** The compiled class `className`, when its instances can carry attributes. */
function attributeClassNamed(lowerer: Lowerer, className: string): ClassInfo | null {
  const info = lowerer.classes.get(className);
  if (!info || runtimeRooted(info) || info.decl == null) return null;
  return info;
}

/** Adds a zero-initialized f64 to every class of the hierarchy, at the same
 * offset, like the property bag. */
function addHiddenField(info: ClassInfo, name: string): void {
  let root = info;
  while (root.base && !root.base.def.runtime) root = root.base;
  if (root.fields.has(name)) return;
  const index = root.def.fields.length;
  const add = (current: ClassInfo): void => {
    if (!current.fields.has(name)) {
      current.fields.set(name, F64);
      current.def.fields.splice(index, 0, { name, type: F64 });
    }
    current.subclasses.forEach(add);
  };
  add(root);
}

/** In a program that freezes, seals or prevents extensions of untyped
 * values, gives every hierarchy whose instances can be held there the
 * integrity word. The runtime applies the operation to the instance's
 * checked view, whose commit stores the view's integrity state in the word
 * (backend streamTypedRefCommitAdapter), and the write checks below read
 * it. */
export function addUntypedIntegrityWords(lowerer: Lowerer): void {
  if (!lowerer.untypedIntegrity) return;
  for (const [className, info] of lowerer.classes) {
    if (isDynTypedRefType({ kind: "object", className }) && attributeClassNamed(lowerer, className))
      addHiddenField(info, CLASS_ATTRIBUTES);
  }
}

function hiddenFieldGet(receiver: IrExpr, className: string, field: string, loc: SrcLoc): IrExpr {
  return { kind: "fieldGet", obj: receiver, className, field, type: F64, loc };
}

/** Object.freeze, Object.seal and Object.preventExtensions of a class
 * instance: sets the instance's integrity bits, then applies the operation to
 * the properties added to the instance. Answers the instance. */
export function lowerClassIntegrity(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "freeze" | "seal" | "preventExtensions",
  target: IrExpr,
): IrExpr | null {
  const info = attributeClass(lowerer, target);
  if (!info) return null;
  addHiddenField(info, CLASS_ATTRIBUTES);
  const loc = locOf(call);
  const type = target.type as ClassObjectType;
  const bits =
    member === "freeze"
      ? CLASS_NOT_EXTENSIBLE | CLASS_SEALED | CLASS_FROZEN
      : member === "seal"
        ? CLASS_NOT_EXTENSIBLE | CLASS_SEALED
        : CLASS_NOT_EXTENSIBLE;
  const slot = lowerer.declareHiddenLocal("%integrityReceiver", type);
  const receiver = (): IrExpr => varRef(slot.id, type, loc);
  const bag: IrExpr = {
    kind: "call",
    callee: classPropertiesHelper(lowerer, loc).name,
    args: [lowerer.coerceToExpected(receiver(), DYN)],
    type: DYN,
    loc,
  };
  const operation = {
    freeze: "dyn.freeze",
    seal: "dyn.seal",
    preventExtensions: "dyn.preventExtensions",
  } as const;
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: slot.id, init: target, loc },
      {
        kind: "fieldSet",
        obj: receiver(),
        className: type.className,
        field: CLASS_ATTRIBUTES,
        value: {
          kind: "bin",
          op: "|",
          left: hiddenFieldGet(receiver(), type.className, CLASS_ATTRIBUTES, loc),
          right: numLit(bits, loc),
          type: F64,
          loc,
        },
        attributesChecked: true,
        loc,
      },
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: operation[member], args: [bag], type: DYN, loc },
        loc,
      },
    ],
    result: receiver(),
    type,
    loc,
  };
}

/** An object literal with a get or set property. */
function literalAccessorDescriptor(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.nodes.some(
      (property) =>
        property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        (property.name.text === "get" || property.name.text === "set"),
    )
  );
}

/** Object.defineProperty with a string-literal key naming a declared field
 * of a class instance: a data descriptor changes the field's value and
 * attributes, validated as Node validates ordinary objects. Answers the
 * instance, or null when the call is not of that form. An object-literal
 * accessor descriptor is refused at compile time; other accessor
 * descriptors throw SC2020 when the call runs. */
export function lowerClassFieldDefine(
  lowerer: Lowerer,
  call: ts.CallExpression,
  target: IrExpr,
): IrExpr | null {
  const info = attributeClass(lowerer, target);
  const key = call.arguments.nodes[1]!;
  if (!info || !ts.isStringLiteral(key)) return null;
  const field = key.text;
  const fieldType = info.fields.get(field);
  if (
    fieldType === undefined ||
    !isClassOwnEnumerableFieldName(field) ||
    [...(info.symbolFields?.values() ?? [])].includes(field)
  )
    return null;
  if (literalAccessorDescriptor(call.arguments.nodes[2]!)) {
    lowerer.pushDiag({
      code: "SC2020",
      message: `Object.defineProperty with an accessor descriptor for the declared field '${field}' is not supported yet`,
      loc: locOf(call),
    });
    throw new PoisonError();
  }
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  if (
    !canConvertToDyn(fieldType, getRecord, getUnion) ||
    !canDynCheckTo(fieldType, getRecord, getUnion)
  )
    return null;
  const attributesField = classFieldAttributesName(field);
  addHiddenField(info, CLASS_ATTRIBUTES);
  addHiddenField(info, attributesField);
  const loc = locOf(call);
  const type = target.type as ClassObjectType;
  const receiverSlot = lowerer.declareHiddenLocal("%defineReceiver", type);
  const descriptorSlot = lowerer.declareHiddenLocal("%defineDescriptor", DYN);
  const holderSlot = lowerer.declareHiddenLocal("%defineHolder", DYN);
  const receiver = (): IrExpr => varRef(receiverSlot.id, type, loc);
  const descriptor = (): IrExpr => varRef(descriptorSlot.id, DYN, loc);
  const holder = (): IrExpr => varRef(holderSlot.id, DYN, loc);
  const name = (): IrExpr => strLit(field, loc);
  const current: IrExpr = {
    kind: "fieldGet",
    obj: receiver(),
    className: type.className,
    field,
    type: fieldType,
    loc,
  };
  const defined: IrExpr = {
    kind: "libCall",
    fn: "class.definedValue",
    args: [holder(), name()],
    type: DYN,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverSlot.id, init: target, loc },
      {
        kind: "varDecl",
        localId: descriptorSlot.id,
        init: lowerer.lowerExprExpecting(call.arguments.nodes[2]!, DYN),
        loc,
      },
      {
        kind: "varDecl",
        localId: holderSlot.id,
        init: {
          kind: "libCall",
          fn: "class.defineField",
          args: [
            lowerer.coerceToExpected(current, DYN),
            hiddenFieldGet(receiver(), type.className, attributesField, loc),
            hiddenFieldGet(receiver(), type.className, CLASS_ATTRIBUTES, loc),
            name(),
            descriptor(),
          ],
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "if",
        cond: {
          kind: "libCall",
          fn: "class.descriptorHasValue",
          args: [descriptor()],
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "fieldSet",
            obj: receiver(),
            className: type.className,
            field,
            value: lowerer.coerceToExpected(defined, fieldType),
            attributesChecked: true,
            loc,
          },
        ],
        else_: null,
        loc,
      },
      {
        kind: "fieldSet",
        obj: receiver(),
        className: type.className,
        field: attributesField,
        value: {
          kind: "libCall",
          fn: "class.definedBits",
          args: [holder(), name()],
          type: F64,
          loc,
        },
        attributesChecked: true,
        loc,
      },
    ],
    result: receiver(),
    type,
    loc,
  };
}

/** The property key of `field` when it is the storage of a symbol-keyed
 * field of `info`, as the read-only TypeError names it: the symbol's
 * String() form ("Symbol(tag)"), read from the module global that holds
 * the symbol. Null for other fields. */
function symbolFieldKey(
  lowerer: Lowerer,
  info: ClassInfo,
  field: string,
  loc: SrcLoc,
): IrExpr | null {
  if (info.symbolFields === undefined) return null;
  for (const [symbol, name] of info.symbolFields) {
    if (name !== field) continue;
    const global = lowerer.globalsBySymbol.get(symbol);
    if (global?.type.kind !== "symbol") return null;
    return {
      kind: "libCall",
      fn: "sym.toString",
      args: [varRef(global.id, global.type, loc)],
      type: STRING,
      loc,
    };
  }
  return null;
}

function classDisplayName(info: ClassInfo): string {
  return info.def.jsName ?? info.decl?.name?.text ?? info.def.name.replace(/^%/, "");
}

/** The instance's own class name for an error message: a helper testing the
 * most derived classes of the hierarchy first. */
function instanceClassName(
  lowerer: Lowerer,
  info: ClassInfo,
  receiver: IrExpr,
  helpers: Map<string, IrFunction>,
  loc: SrcLoc,
): IrExpr {
  if (info.subclasses.length === 0) return strLit(classDisplayName(info), loc);
  let helper = helpers.get(info.def.name);
  if (!helper) {
    const type: IrType = { kind: "object", className: info.def.name };
    const value = varRef("value", type, loc);
    const descendants = (current: ClassInfo): ClassInfo[] =>
      current.subclasses.flatMap((child) => [...descendants(child), child]);
    const body: IrStmt[] = descendants(info).map((child): IrStmt => ({
      kind: "if",
      cond: { kind: "instanceOf", value, className: child.def.name, type: BOOL, loc },
      then: [{ kind: "return", value: strLit(classDisplayName(child), loc), loc }],
      else_: null,
      loc,
    }));
    body.push({ kind: "return", value: strLit(classDisplayName(info), loc), loc });
    helper = {
      name: `%class.instanceName.${helpers.size}`,
      params: [{ localId: "value", name: "value", type }],
      returnType: STRING,
      locals: [{ id: "value", name: "value", type, mutable: false }],
      body,
      loc,
    };
    helpers.set(info.def.name, helper);
  }
  return { kind: "call", callee: helper.name, args: [receiver], type: STRING, loc };
}

/** Checks the integrity word, and the field's attribute word when it has one,
 * before every write to a declared field of a hierarchy that has them. A
 * read-only field throws Node's TypeError in strict mode code; a sloppy-mode
 * write leaves it unchanged. Other classes keep their plain stores. */
export function guardClassAttributeWrites(lowerer: Lowerer, functions: IrFunction[]): void {
  const guarded = new Set(
    [...lowerer.classes.values()]
      .filter((info) => info.def.fields.some((field) => field.name === CLASS_ATTRIBUTES))
      .map((info) => info.def.name),
  );
  if (guarded.size === 0) return;
  const helpers = new Map<string, IrFunction>();
  for (const fn of functions) {
    const local = (type: IrType, loc: SrcLoc): Extract<IrExpr, { kind: "varRef" }> => {
      const id = `%attributeWrite.${fn.locals.length}`;
      fn.locals.push({ id, name: id, type, mutable: false });
      return { kind: "varRef", localId: id, type, loc };
    };
    fn.body = transformStmtList(fn.body, {
      stmt: (statement) => {
        if (
          statement.kind !== "fieldSet" ||
          statement.attributesChecked ||
          !guarded.has(statement.className)
        )
          return statement;
        const info = lowerer.classes.get(statement.className)!;
        const loc = statement.loc;
        // A symbol-keyed field is an own property under its symbol.
        const symbolKey = symbolFieldKey(lowerer, info, statement.field, loc);
        if (!symbolKey && !isClassOwnEnumerableFieldName(statement.field)) return statement;
        const key = (): IrExpr => symbolKey ?? strLit(statement.field, loc);
        const receiver = local(statement.obj.type, loc);
        const value = local(statement.value.type, loc);
        const masked = (field: string, bit: number): IrExpr => ({
          kind: "bin",
          op: "&",
          left: hiddenFieldGet(receiver, statement.className, field, loc),
          right: numLit(bit, loc),
          type: F64,
          loc,
        });
        const attributesField = classFieldAttributesName(statement.field);
        let readOnly = masked(
          CLASS_ATTRIBUTES,
          statement.define ? CLASS_NOT_EXTENSIBLE : CLASS_FROZEN,
        );
        if (!statement.define && info.fields.has(attributesField)) {
          readOnly = {
            kind: "bin",
            op: "|",
            left: readOnly,
            right: masked(attributesField, FIELD_NOT_WRITABLE),
            type: F64,
            loc,
          };
        }
        const reject: IrStmt[] = statement.define
          ? [
              {
                kind: "exprStmt",
                expr: {
                  kind: "libCall",
                  fn: "class.throwNotExtensible",
                  args: [key()],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ]
          : statement.sloppy
            ? []
            : [
                {
                  kind: "exprStmt",
                  expr: {
                    kind: "libCall",
                    fn: "class.throwReadOnly",
                    args: [key(), instanceClassName(lowerer, info, receiver, helpers, loc)],
                    type: VOID,
                    loc,
                  },
                  loc,
                },
              ];
        return {
          kind: "block",
          body: [
            { kind: "varDecl", localId: receiver.localId, init: statement.obj, loc },
            { kind: "varDecl", localId: value.localId, init: statement.value, loc },
            {
              kind: "if",
              cond: {
                kind: "bin",
                op: "!==",
                left: readOnly,
                right: numLit(0, loc),
                type: BOOL,
                loc,
              },
              then: reject,
              else_: [{ ...statement, obj: receiver, value, attributesChecked: true }],
              loc,
            },
          ],
          loc,
        };
      },
      expr: (expression) => expression,
    });
  }
  for (const helper of helpers.values()) functions.push(helper);
}
