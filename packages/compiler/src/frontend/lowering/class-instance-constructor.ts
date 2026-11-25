/* The class of an instance, read through the instance: `x.constructor`.
 *
 * An instance of a class hierarchy already carries its class as the
 * preorder number `instanceof` and virtual dispatch read, and a class as a
 * value is its class object (classRef). `x.constructor` joins the two: a
 * helper selects, by `instanceOf` tests down the subclass tree, what the
 * instance's own class answers. Nothing is stored in an instance or a
 * vtable for it, so a program that never reads `constructor` is unchanged.
 *
 * The helpers are lifted functions named `%class.identity:<kind>:…`:
 *
 * - `name`   the JavaScript name of the instance's class (`x.constructor.name`);
 * - `is`     whether the instance's class is one given class (`x.constructor === K`);
 * - `value`  the class as a checked-dynamic value (`x.constructor` anywhere else);
 * - `cast`   the class as a class value of an asserted type (`x.constructor as typeof K`);
 * - `field`  a static field of the instance's class (`(x.constructor as typeof K).table`);
 * - `call`   a static method of the instance's class (`(x.constructor as typeof K).make()`).
 *
 * A subclass tree grows while bodies lower (class expressions, mixin
 * applications, generic instantiations, function-local classes), so the
 * bodies are rebuilt from the settled class graph in the reachability
 * fixpoint (settleClassIdentityHelpers). The helpers are found there by
 * name, so no state lives outside the lifted functions themselves.
 *
 * A program can replace `constructor` itself: as an own property of an
 * instance (the hidden property bag of a program class, an error's own
 * properties) or on a prototype object. Where it can, the name, identity
 * and value helpers answer from the property when the instance has its
 * own, and through the dynamic view, as a JavaScript source reads it, when
 * the program holds a prototype of the hierarchy as an object. The static
 * forms keep the selection and first check that the constructor the
 * instance reads is still its class. */
import * as ts from "../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import {
  BOOL,
  DYN,
  DYN_CLASS_PROPERTIES,
  STRING,
  classJsName,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { boolLit, strLit, varRef } from "../../ir/build.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { isJsSourceFile, locOf } from "../program.js";
import { PoisonError, type Lowerer } from "./lowerer.js";
import type { ParamShape } from "./call-signatures.js";
import { checkedClassConstruction } from "./class-construction.js";
import { hasRuntimeStatics } from "./class-runtime-statics.js";
import { dateRootOf } from "./builtins/date-classes.js";
import { eventTargetRootOf } from "./lower-event-target.js";
import {
  exactClassOfReceiver,
  findGenericStaticOn,
  findStaticAccessorOn,
  findStaticOn,
  perEvaluationClass,
  staticMethodFunctionFor,
  type ClassInfo,
} from "./lower-classes.js";

const PREFIX = "%class.identity:";

type HelperKind = "name" | "is" | "value" | "cast" | "field" | "call";

interface HelperSpec {
  kind: HelperKind;
  /** The static class of the receiver: the helper's `self` parameter. */
  info: ClassInfo;
  /** The compared class (`is`), the asserted class (`cast`), or the static
   * member's name (`field`, `call`). */
  extra: string;
}

/** `%class.identity:<kind>:<length of the class name>:<class name><extra>`:
 * the class name is length-prefixed because neither it nor a member name
 * has a character that cannot appear in the other. */
function helperName(kind: HelperKind, className: string, extra: string): string {
  return `${PREFIX}${kind}:${className.length}:${className}${extra}`;
}

function helperSpec(lowerer: Lowerer, name: string): HelperSpec | null {
  if (!name.startsWith(PREFIX)) return null;
  const kindEnd = name.indexOf(":", PREFIX.length);
  const lengthEnd = name.indexOf(":", kindEnd + 1);
  const length = Number(name.slice(kindEnd + 1, lengthEnd));
  const className = name.slice(lengthEnd + 1, lengthEnd + 1 + length);
  const info = lowerer.classes.get(className);
  if (!info) return null;
  return {
    kind: name.slice(PREFIX.length, kindEnd) as HelperKind,
    info,
    extra: name.slice(lengthEnd + 1 + length),
  };
}

function displayName(info: ClassInfo): string {
  return info.def.jsName || info.def.name.replace(/^%|^%m\d+\./, "");
}

/** Whether instances of `info` answer `constructor` from their class: the
 * class and every class above it up to a runtime-provided root is a class a
 * TypeScript source declares, whose members the compiler lays out itself.
 * The root is a program class, or a builtin error class (`class AppError
 * extends Error`). A receiver typed as a runtime-provided class itself, and
 * the hierarchies of EventEmitter, the stream classes, Array, Date and
 * EventTarget, keep their own lowerings. */
/** A class that declares a member named `constructor` itself (a field, or
 * an accessor or method under a computed key): its instances read that. */
function declaresConstructorMember(info: ClassInfo): boolean {
  return (
    info.fields.has("constructor") ||
    info.methods.has("constructor") ||
    info.methods.has("get:constructor") ||
    info.methods.has("set:constructor")
  );
}

function identityHierarchy(info: ClassInfo): boolean {
  if (info.def.runtime) return false;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.def.runtime) return c.builtinError === true;
    if (
      !c.decl ||
      c.builtinEmitter ||
      c.builtinStream !== undefined ||
      c.extendsArray ||
      c.callableBase ||
      c.lifetimeRegion ||
      c.internTable ||
      c.threadSlots ||
      c.decorationThrows ||
      declaresConstructorMember(c) ||
      isJsSourceFile(ts.getSourceFileOfNode(c.decl))
    )
      return false;
  }
  return dateRootOf(info) === null && eventTargetRootOf(info) === null;
}

/** `X.constructor` (under the erased wrappers) in a TypeScript source, where
 * X's static type is a class whose instances answer `constructor` from
 * their class (identityHierarchy). */
export interface InstanceConstructor {
  access: ts.PropertyAccessExpression;
  info: ClassInfo;
}

export function instanceConstructorOf(
  lowerer: Lowerer,
  node: ts.Expression,
): InstanceConstructor | null {
  const access = withoutParenthesesTypeWrappers(node);
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.questionDotToken ||
    ts.isPrivateIdentifier(access.name) ||
    access.name.text !== "constructor" ||
    isJsSourceFile(ts.getSourceFileOfNode(access))
  )
    return null;
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (mapped?.kind !== "object") return null;
  const info = lowerer.classes.get(mapped.className);
  if (!info || !identityHierarchy(info)) return null;
  return { access, info };
}

/** The receiver of `ctor`, evaluated once, with the class its lowered type
 * names (a narrowed receiver names a subclass of the checker's). */
function lowerReceiver(
  lowerer: Lowerer,
  ctor: InstanceConstructor,
): { value: IrExpr; info: ClassInfo } {
  let value = lowerer.lowerExpr(ctor.access.expression);
  if (value.type.kind !== "object")
    value = lowerer.coerceToExpected(value, { kind: "object", className: ctor.info.def.name });
  const info = value.type.kind === "object" ? lowerer.classes.get(value.type.className) : undefined;
  if (!info || !identityHierarchy(info)) {
    lowerer.unsupported(
      "SC1090",
      ctor.access,
      `reading 'constructor' of a '${lowerer.fmt(value.type)}' value`,
    );
  }
  return { value, info };
}

/* ── the selection ─────────────────────────────────────────────────────── */

function isAbstract(info: ClassInfo): boolean {
  return (
    info.decl !== null &&
    ts.getModifiers(info.decl)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true
  );
}

/** Whether some instance can have exactly this class: a generic family and
 * an abstract class have none, and neither has a class nothing constructs. */
function instantiable(lowerer: Lowerer, info: ClassInfo): boolean {
  return !info.generic && !isAbstract(info) && lowerer.classCanBeConstructed(info);
}

/** Direct subclasses in name order: the order they collected in follows
 * the order bodies lowered. */
function subclassesOf(info: ClassInfo): ClassInfo[] {
  return [...info.subclasses].sort((a, b) =>
    a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0,
  );
}

function subtreeOf(info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  const visit = (c: ClassInfo): void => {
    out.push(c);
    for (const sub of subclassesOf(c)) visit(sub);
  };
  visit(info);
  return out;
}

/** What one class answers: classes with equal keys answer alike, so the
 * selection tests only where the answer changes. */
interface Leaf {
  key: string;
  make: () => IrExpr;
}

/** The answer of the class of `self` (an instance of `root`'s subtree): the
 * leaf of the instance's own class, selected by `instanceOf` tests on the
 * subclasses whose subtrees answer differently. Null when no class of the
 * subtree can have an instance. */
function selectByClass(
  lowerer: Lowerer,
  root: ClassInfo,
  self: IrExpr,
  type: IrType,
  loc: SrcLoc,
  leafOf: (info: ClassInfo) => Leaf,
): IrExpr | null {
  const memo = new Map<ClassInfo, Map<string, Leaf>>();
  const own = (c: ClassInfo): Leaf | null => (instantiable(lowerer, c) ? leafOf(c) : null);
  const answers = (c: ClassInfo): Map<string, Leaf> => {
    let known = memo.get(c);
    if (known === undefined) {
      known = new Map();
      const leaf = own(c);
      if (leaf) known.set(leaf.key, leaf);
      for (const sub of subclassesOf(c))
        for (const [key, below] of answers(sub)) if (!known.has(key)) known.set(key, below);
      memo.set(c, known);
    }
    return known;
  };
  const select = (c: ClassInfo): IrExpr | null => {
    const known = answers(c);
    if (known.size === 0) return null;
    if (known.size === 1) return [...known.values()][0]!.make();
    const leaf = own(c);
    let result: IrExpr | null = leaf ? leaf.make() : null;
    for (const sub of subclassesOf(c)) {
      const below = answers(sub);
      if (below.size === 0) continue;
      if (leaf && below.size === 1 && below.has(leaf.key)) continue;
      const answer = select(sub)!;
      result =
        result === null
          ? answer
          : {
              kind: "ternary",
              cond: { kind: "instanceOf", value: self, className: sub.def.name, type: BOOL, loc },
              then: answer,
              else_: result,
              type,
              loc,
            };
    }
    return result;
  };
  return select(root);
}

/** How the program can have replaced the `constructor` an instance of
 * `info` reads: as an own property of the instance (`own`), or on a
 * prototype object of its chain (`prototype`).
 *
 * An own property lives in the hidden property bag of a program hierarchy,
 * which exists once the program gives its instances dynamic properties,
 * and in an error's own properties, which always exist. A prototype is an
 * object once the program reads or writes it as data; a function-local
 * class that extends another builds its prototype object with the class. */
function replaceable(info: ClassInfo): { own: boolean; prototype: boolean } {
  const chain: ClassInfo[] = [];
  let errorRooted = false;
  for (let c: ClassInfo | null = info.base; c; c = c.base) {
    if (c.def.runtime) {
      errorRooted = true;
      break;
    }
    chain.push(c);
  }
  const classes = [...chain, ...subtreeOf(info)];
  return {
    own: errorRooted || classes.some((c) => c.fields.has(DYN_CLASS_PROPERTIES)),
    prototype: classes.some(
      (c) => c.def.prototypeDataHelper !== undefined || c.localPrototypeData === true,
    ),
  };
}

/* ── helper bodies ─────────────────────────────────────────────────────── */

type Refuse = (feature: string) => never;

/** The static field `member` as each class of `info`'s subtree resolves it,
 * or the reason no single read answers for all of them. */
function staticFieldPlan(
  lowerer: Lowerer,
  info: ClassInfo,
  member: string,
): { type: IrType } | { refusal: string } | null {
  let type: IrType | null = null;
  for (const c of subtreeOf(info)) {
    if (c.generic) continue;
    if (hasRuntimeStatics(c) || c.callableBase) return null;
    if (findStaticAccessorOn(c, member)) {
      if (c === info) return null;
      return {
        refusal: `reading the static member '${member}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(c)}' redeclares the field as an accessor)`,
      };
    }
    const found = findStaticOn(lowerer, c, member);
    if (!found) {
      if (c === info) return null;
      return {
        refusal: `reading the static member '${member}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(c)}' has no such static)`,
      };
    }
    if (found.field === undefined) return null;
    if (type === null) type = found.field.type;
    else if (!typeEquals(type, found.field.type))
      return {
        refusal: `reading the static member '${member}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(c)}' redeclares it with another type)`,
      };
  }
  return type === null ? null : { type };
}

/** The static method `member` as each class of `info`'s subtree resolves
 * it: one signature for all of them, or the reason there is none. */
function staticCallPlan(
  lowerer: Lowerer,
  blame: ts.Node,
  info: ClassInfo,
  member: string,
): { params: ParamShape[]; ret: IrType } | { refusal: string } | null {
  let plan: { params: ParamShape[]; ret: IrType } | null = null;
  // `get:x` is the getter of the static accessor `x`: it answers for a
  // class only where the accessor is the nearest declaration of `x`.
  const property = member.startsWith("get:") ? member.slice(4) : null;
  const subtree = subtreeOf(info);
  for (const c of subtree) {
    if (c.generic) continue;
    if (hasRuntimeStatics(c) || c.callableBase) return null;
    if (property !== null && findStaticAccessorOn(c, property)?.get !== true) {
      if (c === info) return null;
      return {
        refusal: `reading the static accessor '${property}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(c)}' redeclares it without a getter)`,
      };
    }
    // An accessor collects as `get:x`/`set:x`, which the static method
    // lookup does not see: a subclass that declares the member as an
    // accessor decides the member read, so the inherited method is not
    // the call.
    const accessor = property === null ? findStaticAccessorOn(c, member) : null;
    if (accessor !== null && (accessor.declarer === info || !subtree.includes(accessor.declarer)))
      return null;
    if (accessor !== null)
      return {
        refusal: `calling the static member '${member}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(accessor.declarer)}' redeclares it as an accessor, so the call could invoke the getter's value)`,
      };
    const found = findStaticOn(lowerer, c, member);
    if (!found) {
      if (c === info) return null;
      return {
        refusal: `calling the static member '${member}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(c)}' has no such static)`,
      };
    }
    if (found.method === undefined || !found.method.member.body) return null;
    if (findGenericStaticOn(lowerer, c, member)) return null;
    const { params, ret } = found.method;
    if (params.some((p) => p.mode === "dynRest" || p.mode === "arguments" || p.restTuple))
      return null;
    if (plan === null) plan = { params, ret };
    else if (
      plan.params.length !== params.length ||
      !plan.params.every(
        (p, i) => typeEquals(p.type, params[i]!.type) && p.mode === params[i]!.mode,
      ) ||
      !typeEquals(plan.ret, ret)
    )
      return {
        refusal: `calling the static member '${member}' through the constructor of a '${displayName(info)}' instance (the subclass '${displayName(c)}' redeclares it with another signature)`,
      };
  }
  void blame;
  return plan;
}

/** The class object of `info` as a checked-dynamic value. */
function classValueOf(lowerer: Lowerer, info: ClassInfo, refuse: Refuse): IrExpr {
  if (info.genericInstance)
    refuse(
      `the constructor of an instance of the generic class '${displayName(info)}' as a value (its instantiations are one class in JavaScript; reading its '.name' compiles)`,
    );
  if (info.localClass)
    refuse(
      `the constructor of an instance of the function-local class '${displayName(info)}' as a value (reading its '.name' compiles)`,
    );
  return lowerer.coerceToExpected(lowerer.classValueRef(info, info.decl!), DYN);
}

/** The body of the helper `fn` for `spec`, from the class graph as it
 * stands. */
function helperBody(lowerer: Lowerer, fn: IrFunction, spec: HelperSpec, refuse: Refuse): IrStmt[] {
  const loc = fn.loc;
  const info = spec.info;
  const self = varRef(fn.params[0]!.localId, fn.params[0]!.type, loc);
  const type = fn.returnType;
  const done = (value: IrExpr | null): IrStmt[] =>
    value === null
      ? // No class of the subtree is ever constructed: nothing calls this.
        [{ kind: "runtimeFence", code: "SC1090", message: "unreachable class identity", loc }]
      : [{ kind: "return", value, loc }];
  for (const c of subtreeOf(info))
    if (declaresConstructorMember(c))
      refuse(
        `reading 'constructor' of a '${displayName(info)}' instance (the subclass '${displayName(c)}' declares a member of that name)`,
      );
  const replaced = replaceable(info);
  // The property as the dynamic view reads it: exact wherever the
  // program can have written a prototype. The view answers for classes
  // with one class object only.
  const dynamicConstructor = (): IrExpr => {
    for (const c of subtreeOf(info))
      if (c.genericInstance || c.localClass || c.classDecorators)
        refuse(
          `reading 'constructor' of a '${displayName(info)}' instance whose class prototypes the program holds as objects, in a hierarchy that includes the ${c.localClass ? "function-local" : c.genericInstance ? "generic" : "decorated"} class '${displayName(c)}'`,
        );
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(self, DYN),
      key: strLit("constructor", loc),
      type: DYN,
      loc,
    };
  };
  // The instance's own `constructor`, where it can have one: in the hidden
  // property bag of a program class (absent until the instance takes a
  // dynamic property), or among an error's own properties.
  const key = strLit("constructor", loc);
  const own: { has: IrExpr; read: () => IrExpr } | null = !replaced.own
    ? null
    : info.fields.has(DYN_CLASS_PROPERTIES)
      ? (() => {
          const bag = (): IrExpr => ({
            kind: "fieldGet",
            obj: self,
            className: info.def.name,
            field: DYN_CLASS_PROPERTIES,
            type: DYN,
            loc,
          });
          return {
            has: {
              kind: "ternary",
              cond: { kind: "dynTest", test: "undefined", value: bag(), type: BOOL, loc },
              then: boolLit(false, loc),
              else_: { kind: "libCall", fn: "dyn.hasOwn", args: [bag(), key], type: BOOL, loc },
              type: BOOL,
              loc,
            },
            read: (): IrExpr => ({ kind: "dynKeyGet", value: bag(), key, type: DYN, loc }),
          };
        })()
      : {
          has: {
            kind: "libCall",
            fn: "dyn.hasOwn",
            args: [lowerer.coerceToExpected(self, DYN), key],
            type: BOOL,
            loc,
          },
          read: (): IrExpr => ({
            kind: "dynKeyGet",
            value: lowerer.coerceToExpected(self, DYN),
            key,
            type: DYN,
            loc,
          }),
        };
  // What the read answers: from the property where the program replaced it
  // (`viaProperty`), from the instance's class otherwise (`viaClass`).
  const answer = (viaProperty: (ctor: IrExpr) => IrExpr, viaClass: IrExpr | null): IrStmt[] => {
    if (replaced.prototype) return done(viaProperty(dynamicConstructor()));
    if (own === null || viaClass === null) return done(viaClass);
    return done({
      kind: "ternary",
      cond: own.has,
      then: viaProperty(own.read()),
      else_: viaClass,
      type,
      loc,
    });
  };
  // A static read through the constructor selects by the instance's class,
  // which is the constructor it reads unless the program replaced it. Where
  // it can have, the selection first checks that it did not.
  const staticSelection = (what: string, value: IrExpr | null): IrStmt[] => {
    if (value === null) return done(value);
    let replacedNow: IrExpr | null = own === null ? null : own.has;
    if (replaced.prototype) {
      const expected = selectByClass(lowerer, info, self, DYN, loc, (c) => ({
        key: c.def.name,
        make: () => classValueOf(lowerer, c, refuse),
      }));
      if (expected !== null)
        replacedNow = {
          kind: "unary",
          op: "!",
          operand: {
            kind: "libCall",
            fn: "dyn.sameValue",
            args: [dynamicConstructor(), expected],
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        };
    }
    if (replacedNow === null) return done(value);
    return [
      {
        kind: "if",
        cond: replacedNow,
        then: [
          {
            kind: "runtimeFence",
            code: "SC1090",
            message: `${what} through a 'constructor' property the program replaced is not supported yet`,
            loc,
          },
        ],
        else_: null,
        loc,
      },
      ...done(value),
    ];
  };
  switch (spec.kind) {
    case "name":
      return answer(
        (ctor) =>
          lowerer.coerceToExpected(
            { kind: "dynKeyGet", value: ctor, key: strLit("name", loc), type: DYN, loc },
            STRING,
          ),
        selectByClass(lowerer, info, self, type, loc, (c) => {
          const name = classJsName(c.def);
          return { key: name, make: () => strLit(name, loc) };
        }),
      );
    case "is": {
      const target = lowerer.classes.get(spec.extra);
      if (!target) return done(boolLit(false, loc));
      return answer(
        (ctor) => ({
          kind: "libCall",
          fn: "dyn.sameValue",
          args: [ctor, classValueOf(lowerer, target, refuse)],
          type: BOOL,
          loc,
        }),
        selectByClass(lowerer, info, self, type, loc, (c) => ({
          key: c === target ? "1" : "0",
          make: () => boolLit(c === target, loc),
        })),
      );
    }
    case "value":
      return answer(
        (ctor) => ctor,
        selectByClass(lowerer, info, self, type, loc, (c) => ({
          key: c.def.name,
          make: () => classValueOf(lowerer, c, refuse),
        })),
      );
    case "cast": {
      const target = lowerer.classes.get(spec.extra);
      if (!target || type.kind !== "classval") refuse("this constructor assertion");
      return answer(
        (ctor) => lowerer.coerceToExpected(ctor, type),
        selectByClass(lowerer, info, self, type, loc, (c) => ({
          key: c.def.name,
          make: () => {
            if (c.genericInstance || c.localClass || c.generic)
              refuse(
                `binding the constructor of a '${displayName(c)}' instance as a class value (generic and function-local classes have no single class object)`,
              );
            if (c !== target && !lowerer.isSubclassOf(c.def.name, target.def.name))
              refuse(
                `asserting the constructor of a '${displayName(info)}' instance as 'typeof ${displayName(target)}' (the class '${displayName(c)}' does not extend it)`,
              );
            if (c !== target && !lowerer.ctorAbiEquals(c, target))
              refuse(
                `binding the constructor of a '${displayName(info)}' instance as 'typeof ${displayName(target)}' (the subclass '${displayName(c)}' takes different constructor arguments, so the bound value could not construct through that type; read the static through the assertion directly instead)`,
              );
            const ref = lowerer.classValueRef(c, c.decl!);
            return c === target ? ref : { kind: "upcast", value: ref, type, loc };
          },
        })),
      );
    }
    case "field": {
      const member = spec.extra;
      const plan = staticFieldPlan(lowerer, info, member);
      if (plan === null || "refusal" in plan || !typeEquals(plan.type, type))
        refuse(
          plan !== null && "refusal" in plan
            ? plan.refusal
            : `reading the static member '${member}' through the constructor of a '${displayName(info)}' instance`,
        );
      return staticSelection(
        `reading the static member '${member}'`,
        selectByClass(lowerer, info, self, type, loc, (c) => {
          const found = findStaticOn(lowerer, c, member)!;
          return {
            key: found.declarer.def.name,
            make: () => varRef(found.field!.globalId, found.field!.type, loc),
          };
        }),
      );
    }
    case "call": {
      const member = spec.extra;
      const blame = info.decl!;
      const plan = staticCallPlan(lowerer, blame, info, member);
      if (plan === null || "refusal" in plan)
        refuse(
          plan !== null
            ? plan.refusal
            : `calling the static member '${member}' through the constructor of a '${displayName(info)}' instance`,
        );
      const args = fn.params.slice(1).map((p) => varRef(p.localId, p.type, loc));
      return staticSelection(
        `calling the static member '${member}'`,
        selectByClass(lowerer, info, self, type, loc, (c) => {
          const target = staticMethodFunctionFor(lowerer, blame, c, member);
          if (!target)
            refuse(
              `calling the static member '${member}' through the constructor of a '${displayName(info)}' instance`,
            );
          return {
            key: target.fn,
            make: () => {
              if (!target.receiverDependent) lowerer.noteEdge(target.fn);
              return { kind: "call", callee: target.fn, args, type: target.ret, loc };
            },
          };
        }),
      );
    }
  }
}

/** The helper for `spec`, built from the class graph as it stands and
 * rebuilt once the graph settles. `site` takes the blame for a refusal. */
function helperFor(
  lowerer: Lowerer,
  site: ts.Node,
  spec: HelperSpec,
  params: IrParam[],
  returnType: IrType,
): IrFunction {
  const name = helperName(spec.kind, spec.info.def.name, spec.extra);
  const existing = lowerer.liftedFnNamed(name);
  if (existing) return existing;
  const self: IrParam = {
    localId: "p.0",
    name: "self",
    type: { kind: "object", className: spec.info.def.name },
  };
  const all = [self, ...params];
  const fn: IrFunction = {
    name,
    params: all,
    returnType,
    locals: all.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    body: [],
    loc: spec.info.def.loc,
  };
  fn.body = helperBody(lowerer, fn, spec, (feature) =>
    lowerer.unsupported("SC1090", site, feature),
  );
  lowerer.classIdentityBuilt.set(name, JSON.stringify(fn.body));
  lowerer.liftedFns.push(fn);
  return fn;
}

function callHelper(fn: IrFunction, args: IrExpr[], loc: SrcLoc): IrExpr {
  return { kind: "call", callee: fn.name, args, type: fn.returnType, loc };
}

/** Rebuilds the class-identity helpers from the class graph as it stands:
 * classes join a subtree, and become constructed, while bodies lower. True
 * when a body changed (`forget` is told which), so the reachability
 * fixpoint runs again. A refusal found only now (a class that joined the
 * subtree after the site lowered) is reported at the class the helper is
 * for. */
export function settleClassIdentityHelpers(
  lowerer: Lowerer,
  forget: (fn: IrFunction) => void,
): boolean {
  let changed = false;
  for (const fn of lowerer.liftedFns) {
    const spec = helperSpec(lowerer, fn.name);
    if (!spec) continue;
    let body: IrStmt[];
    try {
      body = helperBody(lowerer, fn, spec, (feature) => {
        lowerer.pushDiag(unsupportedDiag("SC1090", fn.loc, feature));
        throw new PoisonError();
      });
    } catch (e) {
      if (!(e instanceof PoisonError)) throw e;
      body = [{ kind: "runtimeFence", code: "SC1090", message: "class identity", loc: fn.loc }];
    }
    // Compared as built: later passes rewrite a helper's body in place (the
    // dynamic dispatch pass resolves its checked-dynamic reads), and that
    // rewritten body stays until the class graph gives a different answer.
    const built = JSON.stringify(body);
    if (lowerer.classIdentityBuilt.get(fn.name) === built) continue;
    lowerer.classIdentityBuilt.set(fn.name, built);
    fn.body = body;
    forget(fn);
    changed = true;
  }
  return changed;
}

/* ── the sites ─────────────────────────────────────────────────────────── */

/** The class value type an assertion wrapped around `access` gives it
 * (`x.constructor as typeof K`, `x.constructor as unknown as typeof K`),
 * when that names a class of the program; null for an assertion to
 * anything else or none. */
function assertedClassValue(lowerer: Lowerer, access: ts.Expression): ClassInfo | null {
  let outer: ts.Node = access;
  let asserted: ts.Expression | null = null;
  for (;;) {
    const parent: ts.Node | undefined = outer.parent;
    if (parent === undefined) break;
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) {
      outer = parent;
      continue;
    }
    if (ts.isAsExpression(parent) || ts.isTypeAssertion(parent)) {
      outer = parent;
      asserted = parent;
      continue;
    }
    break;
  }
  if (asserted === null) return null;
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(asserted));
  if (mapped?.kind !== "classval") return null;
  return lowerer.classes.get(mapped.className) ?? null;
}

/** `X.constructor` or `X.constructor.name` where X's static type is a union
 * of classes whose instances answer `constructor` from their class: each
 * arm asks its own class's helper. Null for any other receiver. */
function lowerUnionConstructorRead(
  lowerer: Lowerer,
  node: ts.Expression,
  kind: "name" | "value",
  loc: SrcLoc,
): IrExpr | null {
  const access = withoutParenthesesTypeWrappers(node);
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.questionDotToken ||
    ts.isPrivateIdentifier(access.name) ||
    access.name.text !== "constructor" ||
    isJsSourceFile(ts.getSourceFileOfNode(access))
  )
    return null;
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (mapped?.kind !== "union") return null;
  const armClasses = (type: IrType): ClassInfo[] | null => {
    if (type.kind !== "union") return null;
    const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
    const infos: ClassInfo[] = [];
    for (const arm of arms) {
      const info = arm.kind === "object" ? lowerer.classes.get(arm.className) : undefined;
      if (!info || !identityHierarchy(info)) return null;
      infos.push(info);
    }
    return infos.length > 0 ? infos : null;
  };
  if (armClasses(mapped) === null) return null;
  const value = lowerer.lowerExpr(access.expression);
  const infos = armClasses(value.type);
  if (infos === null || value.type.kind !== "union") {
    lowerer.unsupported(
      "SC1090",
      access,
      `reading 'constructor' of a '${lowerer.fmt(value.type)}' value`,
    );
  }
  const unionId = value.type.unionId;
  const type = kind === "name" ? STRING : DYN;
  const local = lowerer.declareHiddenLocal("%constructorOf", value.type);
  const ref = (): IrExpr => varRef(local.id, value.type, loc);
  let result: IrExpr | null = null;
  infos.forEach((info, tag) => {
    const fn = helperFor(lowerer, access, { kind, info, extra: "" }, [], type);
    const arm: IrType = { kind: "object", className: info.def.name };
    const answer = callHelper(
      fn,
      [{ kind: "unionNarrow", unionId, tag, value: ref(), type: arm, loc }],
      loc,
    );
    result =
      result === null
        ? answer
        : {
            kind: "ternary",
            cond: {
              kind: "unionIsTag",
              unionId,
              tag,
              value: ref(),
              negated: false,
              type: BOOL,
              loc,
            },
            then: answer,
            else_: result,
            type,
            loc,
          };
  });
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: result!,
    type,
    loc,
  };
}

/** `X.constructor`, `X.constructor.name` and `(X.constructor as T).member`
 * for an instance X of a program class hierarchy; null for anything else. */
export function lowerInstanceConstructorRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (ts.isPrivateIdentifier(expr.name)) return null;
  const own = instanceConstructorOf(lowerer, expr);
  if (own && withoutParenthesesTypeWrappers(expr) === expr) {
    const target = assertedClassValue(lowerer, expr);
    const recv = lowerReceiver(lowerer, own);
    if (target !== null && identityHierarchy(target)) {
      const fn = helperFor(
        lowerer,
        expr,
        { kind: "cast", info: recv.info, extra: target.def.name },
        [],
        { kind: "classval", className: target.def.name },
      );
      return callHelper(fn, [recv.value], loc);
    }
    const fn = helperFor(lowerer, expr, { kind: "value", info: recv.info, extra: "" }, [], DYN);
    return callHelper(fn, [recv.value], loc);
  }
  {
    const unionValue = lowerUnionConstructorRead(lowerer, expr, "value", loc);
    if (unionValue) return unionValue;
    const unionName =
      expr.name.text === "name"
        ? lowerUnionConstructorRead(lowerer, expr.expression, "name", loc)
        : null;
    if (unionName) return unionName;
  }
  const ctor = instanceConstructorOf(lowerer, expr.expression);
  if (!ctor) return null;
  const member = expr.name.text;
  if (member === "name") {
    const recv = lowerReceiver(lowerer, ctor);
    const fn = helperFor(lowerer, expr, { kind: "name", info: recv.info, extra: "" }, [], STRING);
    return callHelper(fn, [recv.value], loc);
  }
  // A static accessor of the instance's class: its getter, called with the
  // instance's class as `this`.
  if (findStaticAccessorOn(ctor.info, member)) {
    const getter = staticCallPlan(lowerer, expr, ctor.info, `get:${member}`);
    if (getter === null) return null;
    if ("refusal" in getter) lowerer.unsupported("SC1090", expr, getter.refusal);
    const recv = lowerReceiver(lowerer, ctor);
    const fn = helperFor(
      lowerer,
      expr,
      { kind: "call", info: recv.info, extra: `get:${member}` },
      [],
      getter.ret,
    );
    return callHelper(fn, [recv.value], loc);
  }
  // A static field of the instance's class. Anything else the assertion
  // names (a method read as a value, `prototype`, `length`) keeps the
  // lowering of the asserted value.
  const plan = staticFieldPlan(lowerer, ctor.info, member);
  if (plan === null) return null;
  if ("refusal" in plan) lowerer.unsupported("SC1090", expr, plan.refusal);
  const recv = lowerReceiver(lowerer, ctor);
  const narrowed =
    recv.info === ctor.info ? plan : (staticFieldPlan(lowerer, recv.info, member) ?? plan);
  if ("refusal" in narrowed) lowerer.unsupported("SC1090", expr, narrowed.refusal);
  const fn = helperFor(
    lowerer,
    expr,
    { kind: "field", info: recv.info, extra: member },
    [],
    narrowed.type,
  );
  return callHelper(fn, [recv.value], loc);
}

/** `(X.constructor as T).m(args)`: the static method the instance's class
 * resolves, with the arguments completed once against the signature every
 * class of the subtree shares. Null for anything else. */
export function lowerInstanceConstructorStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const callee = call.expression;
  if (
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken ||
    ts.isPrivateIdentifier(callee.name)
  )
    return null;
  const ctor = instanceConstructorOf(lowerer, callee.expression);
  if (!ctor) return null;
  const member = callee.name.text;
  const plan = staticCallPlan(lowerer, call, ctor.info, member);
  if (plan === null) return null;
  if ("refusal" in plan) lowerer.unsupported("SC1090", call, plan.refusal);
  const loc = locOf(call);
  const recv = lowerReceiver(lowerer, ctor);
  const local = lowerer.declareHiddenLocal("%constructorOf", recv.value.type);
  const args = lowerer.completeArgs(call.arguments.nodes, plan.params, loc, call);
  const fn = helperFor(
    lowerer,
    call,
    { kind: "call", info: recv.info, extra: member },
    plan.params.map((p, i) => ({ localId: `p.${i + 1}`, name: `a${i}`, type: p.type })),
    plan.ret,
  );
  // The receiver is evaluated before the arguments, as the member read is.
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: recv.value, loc }],
    result: callHelper(fn, [varRef(local.id, recv.value.type, loc), ...args], loc),
    type: fn.returnType,
    loc,
  };
}

/** `X.constructor === K` and `!==` for a class K of the program: whether
 * the instance's own class is K. Null for anything else. */
export function lowerInstanceConstructorIs(
  lowerer: Lowerer,
  side: ts.Expression,
  other: ts.Expression,
  negated: boolean,
  loc: SrcLoc,
): IrExpr | null {
  const ctor = instanceConstructorOf(lowerer, side);
  if (!ctor) return null;
  const target = exactClassOfReceiver(lowerer, withoutParenthesesTypeWrappers(other));
  if (!target || target.generic || !target.decl) return null;
  // A function-local class is a new class object at each evaluation of its
  // enclosing body, but the compiled class identity is one declaration: the
  // selection would answer for the declaration and compare an instance of
  // another evaluation's class equal, where JavaScript answers false.
  if (target.localClass || perEvaluationClass(target.decl))
    lowerer.unsupported(
      "SC1090",
      other,
      `comparing the constructor of a '${displayName(ctor.info)}' instance with the function-local class '${displayName(target)}' (a function-local class is a new class object at each evaluation)`,
    );
  const recv = lowerReceiver(lowerer, ctor);
  const fn = helperFor(
    lowerer,
    side,
    { kind: "is", info: recv.info, extra: target.def.name },
    [],
    BOOL,
  );
  const test = callHelper(fn, [recv.value], loc);
  return negated ? { kind: "unary", op: "!", operand: test, type: BOOL, loc } : test;
}

/** Select the instance's concrete class before evaluating constructor
 * arguments. Each branch completes arguments against its own constructor,
 * including subclasses with different defaults or parameter counts. */
export function lowerInstanceConstructorNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  const loc = locOf(expr);
  // A TypeScript source: the class value comes from the instance's class
  // (the assertions real code wraps the callee in are erased).
  const typed = instanceConstructorOf(lowerer, expr.expression);
  if (typed) {
    const recv = lowerReceiver(lowerer, typed);
    const fn = helperFor(lowerer, expr, { kind: "value", info: recv.info, extra: "" }, [], DYN);
    const local = lowerer.declareHiddenLocal("%constructorReceiver", DYN);
    const result = checkedClassConstruction(
      lowerer,
      varRef(local.id, DYN, loc),
      (expr.arguments?.nodes ?? []).map((argument) => lowerer.lowerExprExpecting(argument, DYN)),
      loc,
    );
    const type: IrType = { kind: "object", className: typed.info.def.name };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: callHelper(fn, [recv.value], loc), loc }],
      result: lowerer.coerceToExpected(result, type),
      type,
      loc,
    };
  }
  let access = expr.expression;
  while (ts.isParenthesizedExpression(access)) access = access.expression;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.name.text !== "constructor" ||
    access.questionDotToken
  )
    return null;
  let receiver = lowerer.lowerExpr(access.expression);
  const declared =
    receiver.type.kind === "dyn" ? lowerer.mapTypeOf(lowerer.typeOf(access.expression)) : null;
  if (declared?.kind === "object") receiver = lowerer.coerceToExpected(receiver, declared);
  if (receiver.type.kind !== "object") return null;
  const info = lowerer.classes.get(receiver.type.className);
  if (!info || info.def.runtime) return null;
  const local = lowerer.declareHiddenLocal("%constructorReceiver", receiver.type);
  const value = varRef(local.id, receiver.type, loc);
  // Use the incremental checked constructor dispatcher. Enumerating the
  // whole declared hierarchy here would make every imported subclass
  // constructible merely because a base implements clone().
  const constructor: IrExpr = {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(value, DYN),
    key: { kind: "strLit", value: "constructor", type: STRING, loc },
    type: DYN,
    loc,
  };
  const result = checkedClassConstruction(
    lowerer,
    constructor,
    (expr.arguments?.nodes ?? []).map((argument) => lowerer.lowerExprExpecting(argument, DYN)),
    loc,
  );
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
    result: lowerer.coerceToExpected(result, receiver.type),
    type: receiver.type,
    loc,
  };
}
