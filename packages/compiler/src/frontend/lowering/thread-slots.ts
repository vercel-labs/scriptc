/* ThreadSlots (@scriptc/experimental): named families of per-thread values
 * keyed by class instances (scr_slots.c, backend/llvm/thread-slots.ts).
 *
 * A ThreadSlots value is an instance of the synthetic class `%ThreadSlots`
 * with no fields, so it has the identity, typeof and inspection of the
 * Node.js class (whose state is private). A family's per-thread storage is
 * found by its name at compile time, so its methods are called through a
 * module-level const initialized with `new ThreadSlots<K, V>("name")`, and
 * lower at their call sites to slots.get, slots.has, slots.set and
 * slots.delete, with the family name, the const's value and the key:
 * - the name must be a string literal, and every construction of one name
 *   must use the same type arguments;
 * - the key type must be a class (its hierarchy carries the slot word);
 * - the value type must be a class, an object type, an array, a Map or a
 *   Set, so `V | undefined` is a nullable reference.
 * Any other use of the class or its members as values is refused. */
import { STRING, VOID, typeKey } from "../../ir/ir.js";
import type { IrExpr, IrType, SrcLoc } from "../../ir/ir.js";
import {
  type ThreadSlotsMember,
  experimentalImportOf,
  threadSlotsMemberOf,
} from "../experimental-import.js";
import * as ts from "../ts7/adapter.js";
import { withUndefinedArm } from "../type-mapper.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";

export const THREAD_SLOTS_CLASS = "%ThreadSlots";

const BUILTIN_LOC: SrcLoc = { file: "<builtin>", start: 0, end: 0 };

/** Value types a family stores: references that `V | undefined` holds as a
 * nullable pointer. */
const VALUE_KINDS = new Set<IrType["kind"]>(["object", "record", "array", "map", "set"]);

/** The ThreadSlots instance type, registering the class (and its
 * constructor) on first use. */
export function threadSlotsType(lowerer: Lowerer): IrType {
  const type: IrType = { kind: "object", className: THREAD_SLOTS_CLASS };
  if (lowerer.classes.has(THREAD_SLOTS_CLASS)) return type;
  const info: ClassInfo = {
    def: { name: THREAD_SLOTS_CLASS, fields: [], loc: BUILTIN_LOC },
    fields: new Map(),
    fieldOrder: [],
    methods: new Map(),
    decl: null,
    threadSlots: true,
    ctor: null,
    ctorParams: [],
    base: null,
    subclasses: [],
    throwingSetters: [],
    staticFields: [],
  };
  lowerer.classes.set(THREAD_SLOTS_CLASS, info);
  lowerer.liftedFns.push({
    name: `%${THREAD_SLOTS_CLASS}.constructor`,
    params: [{ localId: "this.0", name: "this", type }],
    returnType: VOID,
    locals: [{ id: "this.0", name: "this", type, mutable: false }],
    body: [],
    loc: BUILTIN_LOC,
  });
  return type;
}

interface Family {
  name: string;
  key: IrType;
  value: IrType;
}

/** The root of a class's hierarchy. */
function rootOf(info: ClassInfo): ClassInfo {
  let root = info;
  while (root.base !== null) root = root.base;
  return root;
}

/** The family a `new ThreadSlots<K, V>("name")` expression opens,
 * validated and registered once per expression. */
function familyOf(lowerer: Lowerer, expr: ts.NewExpression): Family {
  const known = lowerer.threadSlotFamilies.get(expr);
  if (known !== undefined) return known;
  const args = expr.arguments?.nodes ?? [];
  const arg = args[0];
  if (args.length !== 1 || arg === undefined || ts.isSpreadElement(arg))
    lowerer.noLowering(`new ThreadSlots with ${args.length} arguments`, expr);
  if (!ts.isStringLiteral(arg!) && !ts.isNoSubstitutionTemplateLiteral(arg!))
    lowerer.unsupported(
      "SC1090",
      arg!,
      "ThreadSlots names other than string literals",
      "name the slots with a string literal: every construction of the name opens the same slots",
    );
  const name = (arg as ts.StringLiteral).text;
  const instance = lowerer.typeOf(expr);
  const typeArgs = lowerer.checker.getTypeArguments(instance as ts.TypeReference);
  if (typeArgs.length !== 2) lowerer.noLowering("ThreadSlots without type arguments", expr);
  const key = lowerer.mapTypeOf(typeArgs[0]!);
  const keyInfo = key?.kind === "object" ? lowerer.classes.get(key.className) : undefined;
  if (
    key?.kind !== "object" ||
    keyInfo === undefined ||
    keyInfo.decl === null ||
    rootOf(keyInfo).def.runtime === true
  )
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${lowerer.checker.typeToString(typeArgs[0]!)}' as a ThreadSlots key type`,
      "key the slots by instances of a class declared in the program",
    );
  const value = lowerer.mapTypeOf(typeArgs[1]!);
  if (value === null || !VALUE_KINDS.has(value.kind))
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${lowerer.checker.typeToString(typeArgs[1]!)}' as a ThreadSlots value type`,
      "store class instances, objects, arrays, Maps or Sets",
    );
  const signature = `${typeKey(key!)}|${typeKey(value!)}`;
  const first = lowerer.threadSlotNames.get(name);
  if (first === undefined) lowerer.threadSlotNames.set(name, signature);
  else if (first !== signature)
    lowerer.unsupported(
      "SC1090",
      expr,
      `opening ThreadSlots ${JSON.stringify(name)} with different type arguments than its first construction`,
      "every construction of one slots name must use the same key and value types",
    );
  lowerer.threadSlotKeys.add((key as IrType & { kind: "object" }).className);
  const family = { name, key: key!, value: value! };
  lowerer.threadSlotFamilies.set(expr, family);
  return family;
}

/** `new ThreadSlots<K, V>("name")`. */
export function lowerThreadSlotsNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  if (experimentalImportOf(lowerer.program, expr.expression) !== "ThreadSlots") return null;
  familyOf(lowerer, expr);
  return {
    kind: "new",
    className: THREAD_SLOTS_CLASS,
    args: [],
    type: threadSlotsType(lowerer),
    loc: locOf(expr),
  };
}

/** The `new ThreadSlots(...)` initializer of the module-level const that
 * `receiver` names (through imports and namespace imports), or of the
 * slots whose `set` call
 * `receiver` is (`slots.set(a, x).set(b, y)`), or null. */
function declaringNew(lowerer: Lowerer, receiver: ts.Expression): ts.NewExpression | null {
  if (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    threadSlotsMemberOf(lowerer.program, receiver.expression, lowerer.experimentalFiles) === "set"
  )
    return declaringNew(lowerer, receiver.expression.expression);
  // `slots`, or `ns.slots` through a namespace import.
  const ref = ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver;
  if (!ts.isIdentifier(ref)) return null;
  const checker = lowerer.checker;
  let symbol = checker.getSymbolAtLocation(ref);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return null;
  const list = decl.parent;
  if (
    !ts.isVariableDeclarationList(list) ||
    (list.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isVariableStatement(list.parent) ||
    !ts.isSourceFile(list.parent.parent)
  )
    return null;
  const init = decl.initializer;
  if (init === undefined || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression))
    return null;
  return experimentalImportOf(lowerer.program, init.expression) === "ThreadSlots" ? init : null;
}

/** The refusal of ThreadSlots members used as values. */
export function lowerThreadSlotsProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = threadSlotsMemberOf(lowerer.program, expr, lowerer.experimentalFiles);
  if (member === null) return null;
  return lowerer.noLowering(
    `ThreadSlots.${member} (@scriptc/experimental) as a value`,
    expr,
    `call slots.${member}(...) directly`,
  );
}

/** `slots.get(k)`, `has`, `set` and `delete`. */
export function lowerThreadSlotsCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr | null {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const member: ThreadSlotsMember | null = threadSlotsMemberOf(
    lowerer.program,
    callee,
    lowerer.experimentalFiles,
  );
  if (member === null) return null;
  if (callee.questionDotToken !== undefined || expr.questionDotToken !== undefined)
    lowerer.noLowering(`ThreadSlots.${member} through ?.`, expr, `call slots.${member}() directly`);
  const arity = member === "set" ? 2 : 1;
  if (
    expr.arguments.nodes.length !== arity ||
    expr.arguments.nodes.some((a) => ts.isSpreadElement(a))
  )
    lowerer.noLowering(`ThreadSlots.${member} with ${expr.arguments.nodes.length} arguments`, expr);
  const init = declaringNew(lowerer, callee.expression);
  if (init === null)
    lowerer.unsupported(
      "SC1090",
      callee.expression,
      "ThreadSlots calls through a value other than a module-level const",
      'call the methods through `const slots = new ThreadSlots<K, V>("name")` declared at module scope',
    );
  const family = familyOf(lowerer, init!);
  const loc = locOf(expr);
  const slotsType = threadSlotsType(lowerer);
  const receiver = lowerer.coerceInto(
    callee.expression,
    lowerer.lowerExpr(callee.expression),
    slotsType,
  );
  const keyNode = expr.arguments.nodes[0]!;
  const key = lowerer.coerceInto(keyNode, lowerer.lowerExpr(keyNode), family.key);
  const name: IrExpr = { kind: "strLit", value: family.name, type: STRING, loc };
  const args = [name, receiver, key];
  switch (member) {
    case "get": {
      // The slots hold values in the layout of the type the constructor registered (`family.value`,
      // which `set` stores with). The receiver's annotation can name a structurally wider value
      // type, so the value read is converted to the call's type like any value flowing into it.
      const resultTs = lowerer.typeOf(expr);
      const result = lowerer.mapTypeOf(resultTs);
      if (result === null) lowerer.badType(expr, resultTs);
      const stored = withUndefinedArm(family.value, lowerer.unions);
      if (stored === null) lowerer.badType(expr, resultTs);
      const read: IrExpr = { kind: "intrinsic", name: "slots.get", args, type: stored!, loc };
      return typeKey(stored!) === typeKey(result!) ? read : lowerer.coerceInto(expr, read, result!);
    }
    case "has":
    case "delete":
      return { kind: "intrinsic", name: `slots.${member}`, args, type: { kind: "bool" }, loc };
    case "set": {
      const valueNode = expr.arguments.nodes[1]!;
      const value = lowerer.coerceInto(valueNode, lowerer.lowerExpr(valueNode), family.value);
      // `set` returns the slots; a statement discards them.
      const type = ts.isExpressionStatement(expr.parent) ? VOID : slotsType;
      return { kind: "intrinsic", name: "slots.set", args: [...args, value], type, loc };
    }
  }
}
