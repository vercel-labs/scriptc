import * as ts from "../ts7/adapter.js";
import { indexStoreInBounds } from "./runtime-optional-bounds.js";

/** Program queries the element-state scan needs from the optional-read
 * analysis. Element keys name a native array's element ABI (`typeKey` of
 * the element type); arrays only alias other arrays with the same key,
 * because a conversion to another element type copies the elements and
 * rejects holes and undefined while it does. */
export interface ElementStateHost {
  /** Element keys of every native array `node` can evaluate to: `[]` when
   * it is not a native array (or is a dynamic value, whose own storage is
   * separate), `null` when its element ABI is not known yet (a generic
   * element type). */
  arrayKeys(node: ts.Expression): readonly string[] | null;
  /** The element type behind this key admits `undefined` itself. */
  elementAdmitsUndefined(key: string): boolean;
  /** The value stored by `node` can be `undefined` at runtime. */
  mayBeUndefined(node: ts.Expression): boolean;
  /** A callback argument can return `undefined` at runtime. */
  callbackReturnsUndefined(node: ts.Expression): boolean;
  /** The value may be a plain array-like object, whose missing indices
   * read as undefined. */
  isArrayLikeObject(node: ts.Expression): boolean;
  /** The expression's static type is a string. */
  isString(node: ts.Expression): boolean;
  /** `node` names the standard global `name` (`Array`, `Object`, ...). */
  isGlobal(node: ts.Expression, name: string): boolean;
  /** Element keys of the rest parameter that the spread arguments of
   * `call` fill: `[]` when the callee has none, null when it is unknown. */
  restKeys(call: ts.CallExpression | ts.NewExpression): readonly string[] | null;
  /** Record that iterating `node`'s binding can observe `undefined`.
   * Returns true when the binding was not already recorded. */
  markIterationBinding(node: ts.Identifier): boolean;
  /** The storage slot that alone owns the array `node` references, whose
   * facts are tracked for that slot instead of its element ABI. */
  ownerOf(node: ts.Expression): ts.Symbol | null;
  /** The owning slot a newly built array is stored into. */
  allocationOwner(node: ts.Expression): ts.Symbol | null;
  /** Debug provenance for a new fact. */
  note: ((fact: "undefined" | "holes", key: string, site: ts.Node | undefined) => void) | null;
}

/** What an array value can contain besides present values. */
interface Contents {
  undefined: boolean;
  holes: boolean;
}

const NOTHING: Contents = { undefined: false, holes: false };

/** Methods whose callbacks also visit holes, as `undefined`. */
const HOLE_VISITING = new Set(["find", "findIndex", "findLast", "findLastIndex"]);

/** Array methods returning a new array, by what happens to the receiver's
 * holes in it, and methods returning the receiver itself. */
const HOLES_KEPT = new Set(["slice", "splice", "concat"]);
const HOLES_SKIPPED = new Set(["filter", "flat"]);
const HOLES_FILLED = new Set(["toSorted", "toReversed", "toSpliced", "with"]);
const IN_PLACE = new Set(["sort", "reverse", "fill", "copyWithin"]);

/** Whole-program facts about which native array element ABIs can hold an
 * explicit `undefined` value or a hole, refined per expression for arrays
 * an expression creates itself. An element parameter of an array callback
 * is present whenever its receiver can hold neither: the callback methods
 * skip holes (except the find family), and every explicit `undefined`
 * enters a native array through a store, a copy, or a builtin scanned
 * here. Facts only grow, so the enclosing fixed point stays monotone. */
export class ArrayElementStates {
  private readonly undefinedKeys = new Set<string>();
  private readonly holeyKeys = new Set<string>();
  /** A store wrote a possibly undefined value or a hole into an array
   * whose element ABI is decided per generic instantiation. */
  private anyUndefined = false;
  private anyHoley = false;
  /** Facts of arrays owned by one storage slot. */
  private readonly undefinedOwners = new Set<ts.Symbol>();
  private readonly holeyOwners = new Set<ts.Symbol>();

  /** The node being scanned, for provenance notes. */
  private site: ts.Node | undefined;

  constructor(private readonly host: ElementStateHost) {}

  /** Every element a callback of `method` receives from `receiver` is a
   * present value. */
  elementsPresent(receiver: ts.Expression, method: string): boolean {
    const contents = this.contents(receiver);
    return (
      contents !== null && !contents.undefined && !(HOLE_VISITING.has(method) && contents.holes)
    );
  }

  /** Scans one syntax node; true when a fact was added. */
  scan(node: ts.Node): boolean {
    this.site = node;
    if (ts.isBinaryExpression(node)) return this.scanAssignment(node);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      // `xs[i]++` writes index i, and `xs.length++` grows the array.
      const target = peel(node.operand as ts.Expression);
      if (ts.isElementAccessExpression(target)) return this.addHolesTo(target.expression);
      if (
        ts.isPropertyAccessExpression(target) &&
        target.name.text === "length" &&
        node.operator === ts.SyntaxKind.PlusPlusToken
      )
        return this.addHolesTo(target.expression);
      return false;
    }
    if (ts.isDeleteExpression(node)) {
      const target = peel(node.expression);
      return ts.isElementAccessExpression(target) ? this.addHolesTo(target.expression) : false;
    }
    if (ts.isArrayLiteralExpression(node)) return this.record(node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return this.scanCall(node);
    if (ts.isForOfStatement(node)) return this.scanForOf(node);
    if (ts.isArrayBindingPattern(node)) return this.scanRestPattern(node);
    return false;
  }

  /** `[a, ...rest] = source` copies the remaining indices into a new
   * array: holes become undefined. */
  private scanRestPattern(pattern: ts.ArrayBindingPattern): boolean {
    const last = pattern.elements[pattern.elements.length - 1];
    if (!last || ts.isOmittedExpression(last) || !last.dotDotDotToken) return false;
    // A parameter or nested pattern has no source expression to judge.
    const owner = pattern.parent;
    const source =
      ts.isVariableDeclaration(owner) && owner.name === pattern && owner.initializer
        ? this.contents(owner.initializer)
        : null;
    if (source !== null && !source.undefined && !source.holes) return false;
    const target = last.name;
    if (!ts.isIdentifier(target)) return false;
    return this.addUndefined(this.host.arrayKeys(target));
  }

  /** `[a, ...rest] = source` as an assignment. */
  private scanRestAssignment(node: ts.BinaryExpression): boolean {
    const pattern = peel(node.left);
    if (!ts.isArrayLiteralExpression(pattern)) return false;
    const last = pattern.elements[pattern.elements.length - 1];
    if (!last || !ts.isSpreadElement(last)) return false;
    if (!this.mayYieldUndefined(node.right)) return false;
    return this.addUndefinedTo(last.expression);
  }

  /** Contents of the array `node` evaluates to; null when its element ABI
   * is generic. Arrays the expression creates are judged by how they are
   * built; any other array by the facts of its element ABI. */
  private contents(node: ts.Expression): Contents | null {
    const e = peel(node);
    if (ts.isArrayLiteralExpression(e)) {
      let undefinedValue = false;
      let holes = false;
      for (const element of e.elements) {
        if (ts.isOmittedExpression(element)) holes = true;
        else if (this.valueMayBeUndefined(element)) undefinedValue = true;
      }
      return { undefined: undefinedValue, holes };
    }
    if (ts.isConditionalExpression(e))
      return merge(this.contents(e.whenTrue), this.contents(e.whenFalse));
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
        return merge(this.contents(e.left), this.contents(e.right));
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken)
        return this.contents(e.right);
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const built = this.builtContents(e);
      if (built !== undefined) return built;
    }
    const owner = this.host.ownerOf(e);
    if (owner !== null)
      return { undefined: this.undefinedOwners.has(owner), holes: this.holeyOwners.has(owner) };
    return this.stored(this.host.arrayKeys(e));
  }

  /** Contents of an array a call creates; undefined when the call is not a
   * known array constructor or method. */
  private builtContents(node: ts.CallExpression | ts.NewExpression): Contents | null | undefined {
    const args = node.arguments ?? [];
    const callee = peel(node.expression);
    if (ts.isIdentifier(callee)) {
      if (!this.host.isGlobal(callee, "Array")) return undefined;
      // `new Array(n)` allocates holes; more arguments are the elements.
      if (args.length === 1 && !ts.isSpreadElement(args[0]!) && isNumberLike(args[0]!))
        return { undefined: false, holes: true };
      return { undefined: args.some((arg) => this.valueMayBeUndefined(arg)), holes: false };
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const method = callee.name.text;
    const owner = callee.expression;
    if (this.host.isGlobal(owner, "Array")) {
      if (method === "of")
        return { undefined: args.some((arg) => this.valueMayBeUndefined(arg)), holes: false };
      if (method === "from" || method === "fromAsync") {
        const source = args[0];
        const mapper = args[1];
        // Without a mapper an array-like's missing indices become undefined.
        const fromSource =
          source !== undefined &&
          !ts.isSpreadElement(source) &&
          (this.mayYieldUndefined(source) ||
            (mapper === undefined && this.host.isArrayLikeObject(source)));
        const fromMapper = mapper !== undefined && this.host.callbackReturnsUndefined(mapper);
        return { undefined: fromSource || fromMapper, holes: false };
      }
      return undefined;
    }
    if (this.host.isGlobal(owner, "Object")) {
      // Present-undefined properties are listed as values.
      return method === "values" || method === "entries"
        ? { undefined: true, holes: false }
        : undefined;
    }
    if (this.host.isGlobal(owner, "Promise")) {
      // A settled value can be a runtime-absent result.
      return method === "all" || method === "allSettled"
        ? { undefined: true, holes: false }
        : undefined;
    }
    if (method === "match" || method === "matchAll" || method === "exec" || method === "split") {
      const separator = args[0];
      if (
        method === "split" &&
        separator !== undefined &&
        !ts.isSpreadElement(separator) &&
        this.host.isString(separator)
      )
        return NOTHING;
      // Non-participating capture groups produce undefined entries.
      return { undefined: true, holes: false };
    }
    const receiverKeys = this.host.arrayKeys(owner);
    if (receiverKeys !== null && receiverKeys.length === 0) return undefined;
    if (method === "map") {
      const callback = args[0];
      const receiver = this.contents(owner);
      // map keeps the receiver's holes; its values are the callback's.
      if (receiver === null) return null;
      return {
        undefined: callback !== undefined && this.host.callbackReturnsUndefined(callback),
        holes: receiver.holes,
      };
    }
    if (method === "flatMap") {
      const callback = args[0];
      if (callback !== undefined && this.host.callbackReturnsUndefined(callback))
        return { undefined: true, holes: false };
      // Returned arrays are flattened, keeping their explicit undefined.
      const flattened = this.stored(this.host.arrayKeys(node));
      return flattened === null ? null : { undefined: flattened.undefined, holes: false };
    }
    if (
      !IN_PLACE.has(method) &&
      !HOLES_KEPT.has(method) &&
      !HOLES_SKIPPED.has(method) &&
      !HOLES_FILLED.has(method)
    )
      return undefined;
    const receiver = this.contents(owner);
    // A whole-array fill writes every slot.
    if (method === "fill" && args.length === 1 && !ts.isSpreadElement(args[0]!))
      return receiver === null
        ? null
        : { undefined: this.host.mayBeUndefined(args[0]!), holes: false };
    if (IN_PLACE.has(method) || receiver === null) return receiver;
    if (HOLES_KEPT.has(method)) {
      let undefinedValue = receiver.undefined;
      let holes = receiver.holes;
      // concat appends its arguments; the slices splice returns keep holes.
      if (method === "concat") {
        for (const arg of args) {
          if (ts.isSpreadElement(arg)) {
            if (this.mayYieldUndefined(arg.expression)) undefinedValue = true;
            continue;
          }
          const keys = this.host.arrayKeys(arg);
          if (keys !== null && keys.length === 0) {
            if (this.host.mayBeUndefined(arg)) undefinedValue = true;
            continue;
          }
          const other = this.contents(arg);
          if (other === null) return null;
          undefinedValue ||= other.undefined;
          holes ||= other.holes;
        }
      }
      return { undefined: undefinedValue, holes };
    }
    if (HOLES_SKIPPED.has(method)) {
      if (method === "flat") {
        // Nested arrays are flattened, keeping their explicit undefined.
        const flattened = this.stored(this.host.arrayKeys(node));
        if (flattened === null) return null;
        return { undefined: receiver.undefined || flattened.undefined, holes: false };
      }
      return { undefined: receiver.undefined, holes: false };
    }
    let undefinedValue = receiver.undefined || receiver.holes;
    if (method === "with" && args[1] !== undefined && this.valueMayBeUndefined(args[1]))
      undefinedValue = true;
    if (method === "toSpliced")
      for (const arg of args.slice(2)) if (this.valueMayBeUndefined(arg)) undefinedValue = true;
    return { undefined: undefinedValue, holes: false };
  }

  /** The facts recorded for arrays with these element ABIs. */
  private stored(keys: readonly string[] | null): Contents | null {
    if (keys === null) return null;
    return {
      undefined:
        this.anyUndefined ||
        keys.some((key) => this.undefinedKeys.has(key) || this.host.elementAdmitsUndefined(key)),
      holes: this.anyHoley || keys.some((key) => this.holeyKeys.has(key)),
    };
  }

  /** Reading every index of `node` (a spread, an iteration, `Array.from`)
   * can produce `undefined`. Only native arrays can: other iterables reject
   * an undefined value when it is stored. */
  private mayYieldUndefined(node: ts.Expression): boolean {
    const keys = this.host.arrayKeys(node);
    if (keys !== null && keys.length === 0) return false;
    const contents = this.contents(node);
    return contents === null
      ? this.anyUndefined || this.anyHoley
      : contents.undefined || contents.holes;
  }

  /** One stored value, or the elements a spread copies. */
  private valueMayBeUndefined(value: ts.Expression): boolean {
    if (ts.isSpreadElement(value)) return this.mayYieldUndefined(value.expression);
    return this.host.mayBeUndefined(value);
  }

  /** Records an array the expression creates, for the slot that owns it
   * or else under its element ABI. */
  private record(node: ts.Expression): boolean {
    // Only array constructors and methods build an array whose contents
    // can differ from what its element ABI already records.
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !buildsArray(node)) return false;
    if (consumedWhereBuilt(node)) return false;
    // An empty literal holds nothing.
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) return false;
    const contents = this.contents(node);
    if (contents === null || (!contents.undefined && !contents.holes)) return false;
    const keys = this.keysAsUsed(node);
    if (keys !== null && keys.length === 0) return false;
    const owner = this.host.allocationOwner(node);
    if (owner !== null) {
      let changed = false;
      if (contents.undefined && !this.undefinedOwners.has(owner)) {
        this.undefinedOwners.add(owner);
        changed = true;
      }
      if (contents.holes && !this.holeyOwners.has(owner)) {
        this.holeyOwners.add(owner);
        changed = true;
      }
      return changed;
    }
    let changed = false;
    if (contents.undefined && this.addUndefined(keys)) changed = true;
    if (contents.holes && this.addHoles(keys)) changed = true;
    return changed;
  }

  /** Element ABIs of a built array, including those an enclosing type
   * assertion gives it (`[a, , b] as T[]`). */
  private keysAsUsed(node: ts.Expression): readonly string[] | null {
    const keys = new Set<string>();
    for (let e: ts.Node = node; ; e = e.parent!) {
      const own = this.host.arrayKeys(e as ts.Expression);
      if (own === null) return null;
      for (const key of own) keys.add(key);
      const parent = e.parent;
      if (
        !parent ||
        !(
          ts.isParenthesizedExpression(parent) ||
          ts.isAsExpression(parent) ||
          ts.isTypeAssertion(parent) ||
          ts.isSatisfiesExpression(parent) ||
          ts.isNonNullExpression(parent)
        )
      )
        break;
    }
    return [...keys];
  }

  /** A store through `receiver` can add an undefined value. */
  private addUndefinedTo(receiver: ts.Expression): boolean {
    const owner = this.host.ownerOf(receiver);
    if (owner === null) return this.addUndefined(this.host.arrayKeys(receiver));
    if (this.undefinedOwners.has(owner)) return false;
    this.undefinedOwners.add(owner);
    return true;
  }

  /** A store through `receiver` can leave holes. */
  private addHolesTo(receiver: ts.Expression): boolean {
    const owner = this.host.ownerOf(receiver);
    if (owner === null) return this.addHoles(this.host.arrayKeys(receiver));
    if (this.holeyOwners.has(owner)) return false;
    this.holeyOwners.add(owner);
    return true;
  }

  private addUndefined(keys: readonly string[] | null): boolean {
    if (keys === null) {
      if (this.anyUndefined) return false;
      this.anyUndefined = true;
      this.host.note?.("undefined", "*", this.site);
      return true;
    }
    let changed = false;
    for (const key of keys) {
      if (this.undefinedKeys.has(key)) continue;
      this.undefinedKeys.add(key);
      this.host.note?.("undefined", key, this.site);
      changed = true;
    }
    return changed;
  }

  private addHoles(keys: readonly string[] | null): boolean {
    if (keys === null) {
      if (this.anyHoley) return false;
      this.anyHoley = true;
      this.host.note?.("holes", "*", this.site);
      return true;
    }
    let changed = false;
    for (const key of keys) {
      if (this.holeyKeys.has(key)) continue;
      this.holeyKeys.add(key);
      this.host.note?.("holes", key, this.site);
      changed = true;
    }
    return changed;
  }

  private scanAssignment(node: ts.BinaryExpression): boolean {
    const op = node.operatorToken.kind;
    if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return false;
    const target = peel(node.left);
    if (op === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(target))
      return this.scanRestAssignment(node);
    if (ts.isElementAccessExpression(target)) {
      // A write past the end leaves holes before it; appending at the
      // receiver's own length does not.
      const holes = !isAppendIndex(target) && !indexStoreInBounds(node);
      const storesValue =
        op === ts.SyntaxKind.EqualsToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken ||
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
      const undefinedValue = storesValue && this.host.mayBeUndefined(node.right);
      if (!holes && !undefinedValue) return false;
      const keys = this.host.arrayKeys(target.expression);
      if (keys !== null && keys.length === 0) return false;
      let changed = false;
      if (holes && this.addHolesTo(target.expression)) changed = true;
      if (undefinedValue && this.addUndefinedTo(target.expression)) changed = true;
      return changed;
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === "length" &&
      !isShrinkingLength(node, target)
    ) {
      const keys = this.host.arrayKeys(target.expression);
      if (keys !== null && keys.length === 0) return false;
      return this.addHolesTo(target.expression);
    }
    return false;
  }

  private scanCall(node: ts.CallExpression | ts.NewExpression): boolean {
    let changed = false;
    const args = node.arguments ?? [];
    // Spreading a sparse array into a rest parameter fills the holes.
    if (args.some((arg) => ts.isSpreadElement(arg))) {
      for (const arg of args) {
        if (!ts.isSpreadElement(arg) || !this.mayYieldUndefined(arg.expression)) continue;
        const rest = this.host.restKeys(node) ?? this.host.arrayKeys(arg.expression);
        if (this.addUndefined(rest)) changed = true;
      }
    }
    if (this.record(node)) changed = true;
    const callee = peel(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return changed;
    if (this.scanReflectiveWrite(callee, args)) changed = true;
    // In-place stores into the receiver.
    let stored: readonly ts.Expression[];
    switch (callee.name.text) {
      case "push":
      case "unshift":
        stored = args;
        break;
      case "splice":
        stored = args.slice(2);
        break;
      case "fill":
        if (args.length === 0 && this.addUndefinedTo(callee.expression)) changed = true;
        stored = args.slice(0, 1);
        break;
      default:
        return changed;
    }
    const receiver = this.host.arrayKeys(callee.expression);
    if (receiver !== null && receiver.length === 0) return changed;
    for (const value of stored)
      if (this.valueMayBeUndefined(value) && this.addUndefinedTo(callee.expression)) changed = true;
    return changed;
  }

  /** Writes that bypass the array methods: `Object.assign(xs, ...)`,
   * `Reflect.set(xs, ...)`, `Array.prototype.push.call(xs, ...)` and the
   * like may store any value at any index of an array argument. */
  private scanReflectiveWrite(
    callee: ts.PropertyAccessExpression,
    args: readonly ts.Expression[],
  ): boolean {
    const method = callee.name.text;
    const owner = peel(callee.expression);
    const reflective =
      (this.host.isGlobal(owner, "Object") &&
        (method === "assign" ||
          method === "defineProperty" ||
          method === "defineProperties" ||
          method === "setPrototypeOf")) ||
      (this.host.isGlobal(owner, "Reflect") &&
        (method === "set" || method === "defineProperty" || method === "apply")) ||
      ((method === "call" || method === "apply") &&
        ts.isPropertyAccessExpression(owner) &&
        ts.isPropertyAccessExpression(peel(owner.expression)) &&
        (peel(owner.expression) as ts.PropertyAccessExpression).name.text === "prototype" &&
        this.host.isGlobal(
          (peel(owner.expression) as ts.PropertyAccessExpression).expression,
          "Array",
        ));
    if (!reflective) return false;
    let changed = false;
    for (const arg of args) {
      const target = ts.isSpreadElement(arg) ? arg.expression : arg;
      const keys = this.host.arrayKeys(target);
      if (keys !== null && keys.length === 0) continue;
      if (this.addUndefinedTo(target)) changed = true;
      if (this.addHolesTo(target)) changed = true;
    }
    return changed;
  }

  private scanForOf(node: ts.ForOfStatement): boolean {
    let source = peel(node.expression);
    if (
      ts.isCallExpression(source) &&
      ts.isPropertyAccessExpression(source.expression) &&
      (source.expression.name.text === "values" || source.expression.name.text === "entries") &&
      source.arguments.length === 0
    ) {
      const receiver = this.host.arrayKeys(source.expression.expression);
      if (receiver === null || receiver.length > 0) source = source.expression.expression;
    }
    if (!this.mayYieldUndefined(source)) return false;
    const initializer = node.initializer;
    let changed = false;
    const mark = (name: ts.Node): void => {
      if (ts.isIdentifier(name)) {
        if (this.host.markIterationBinding(name)) changed = true;
        return;
      }
      name.forEachChild(mark);
    };
    if (ts.isVariableDeclarationList(initializer)) {
      for (const declaration of initializer.declarations) mark(declaration.name);
    } else mark(initializer);
    return changed;
  }
}

/** Names of the constructors, methods and builtins that return a new
 * array or their receiver. */
const ARRAY_BUILDERS = new Set([
  "Array",
  "of",
  "from",
  "fromAsync",
  "values",
  "entries",
  "all",
  "allSettled",
  "match",
  "matchAll",
  "exec",
  "split",
  "map",
  "flatMap",
  ...HOLES_KEPT,
  ...HOLES_SKIPPED,
  ...HOLES_FILLED,
  ...IN_PLACE,
]);

function buildsArray(node: ts.CallExpression | ts.NewExpression): boolean {
  const callee = peel(node.expression);
  if (ts.isIdentifier(callee)) return callee.text === "Array";
  return ts.isPropertyAccessExpression(callee) && ARRAY_BUILDERS.has(callee.name.text);
}

/** Callback methods, by the position of the parameter receiving the
 * array itself. */
const ARRAY_ARGUMENT_AT = new Map([
  ["map", 2],
  ["filter", 2],
  ["forEach", 2],
  ["some", 2],
  ["every", 2],
  ["find", 2],
  ["findIndex", 2],
  ["findLast", 2],
  ["findLastIndex", 2],
  ["flatMap", 2],
  ["reduce", 3],
  ["reduceRight", 3],
]);

/** A newly built array that is used up where it is built: discarded, or
 * read by a spread, an iteration, or a method call whose callback cannot
 * see it. Nothing else ever references it, so only the value derived from
 * it (judged by its own contents) can carry its holes or undefined. */
function consumedWhereBuilt(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isExpressionStatement(parent)) return true;
  if (ts.isSpreadElement(parent)) return true;
  if (ts.isForOfStatement(parent)) return parent.expression === child;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === child &&
    parent.parent &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    const arrayAt = ARRAY_ARGUMENT_AT.get(parent.name.text);
    if (arrayAt === undefined) return true;
    const callback = parent.parent.arguments[0];
    return (
      callback !== undefined &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters.length <= arrayAt &&
      !callback.parameters.some((parameter) => parameter.dotDotDotToken) &&
      ts.isArrowFunction(callback)
    );
  }
  return false;
}

function merge(a: Contents | null, b: Contents | null): Contents | null {
  if (a === null || b === null) return null;
  return { undefined: a.undefined || b.undefined, holes: a.holes || b.holes };
}

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

function sameReference(a: ts.Expression, b: ts.Expression): boolean {
  const left = peel(a);
  const right = peel(b);
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) return left.text === right.text;
  if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword)
    return true;
  if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(right))
    return left.name.text === right.name.text && sameReference(left.expression, right.expression);
  return false;
}

/** `xs[xs.length] = v` appends without leaving a hole. */
function isAppendIndex(target: ts.ElementAccessExpression): boolean {
  const index = peel(target.argumentExpression);
  return (
    ts.isPropertyAccessExpression(index) &&
    index.name.text === "length" &&
    sameReference(index.expression, target.expression)
  );
}

/** `xs.length = 0`, `xs.length = xs.length - k` and `xs.length -= k`
 * truncate; truncation never leaves holes. */
function isShrinkingLength(
  node: ts.BinaryExpression,
  target: ts.PropertyAccessExpression,
): boolean {
  const op = node.operatorToken.kind;
  const right = peel(node.right);
  if (op === ts.SyntaxKind.MinusEqualsToken) return ts.isNumericLiteral(right);
  if (op !== ts.SyntaxKind.EqualsToken) return false;
  if (ts.isNumericLiteral(right)) return Number(right.text) === 0;
  if (!ts.isBinaryExpression(right) || right.operatorToken.kind !== ts.SyntaxKind.MinusToken)
    return false;
  const length = peel(right.left);
  return (
    ts.isNumericLiteral(peel(right.right)) &&
    ts.isPropertyAccessExpression(length) &&
    length.name.text === "length" &&
    sameReference(length.expression, target.expression)
  );
}

function isNumberLike(node: ts.Expression): boolean {
  const e = peel(node);
  return !(
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword
  );
}
