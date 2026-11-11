import * as ts from "../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
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
  /** Iterating `node`, an iterable other than an array (a Set, a Map's
   * values, a generator), can yield `undefined`. */
  iterationMayYieldUndefined?(node: ts.Expression): boolean;
  /** An entry of the `Promise.all` call `node` can settle with `undefined`:
   * the checker types an element of its result as possibly undefined. */
  settledMayBeUndefined?(node: ts.CallExpression): boolean;
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
  /** The argument index where the callee's rest parameter starts, or null
   * when the callee has none or is unknown. */
  restStart?(call: ts.CallExpression | ts.NewExpression): number | null;
  /** Record that iterating `node`'s binding can observe `undefined`;
   * `known` when the iterated array's own facts (not only those shared by
   * its element ABI) say so. Returns true when the binding's record grew. */
  markIterationBinding(node: ts.Identifier, known: boolean): boolean;
  /** The storage slot that alone owns the array `node` references, whose
   * facts are tracked for that slot instead of its element ABI. */
  ownerOf(node: ts.Expression): ts.Symbol | null;
  /** The owning slot a newly built array is stored into. */
  allocationOwner(node: ts.Expression): ts.Symbol | null;
  /** `node` is a dynamic value (`any`, `unknown`, `unknown[]`): when it is
   * a live view of a native array, a store through it writes that array's
   * storage. */
  isDynamicArray(node: ts.Expression): boolean;
  /** Element keys of the native arrays a value converted to a dynamic type
   * can reach, as live views ("*" for any array). */
  nativeViewKeys(): ReadonlySet<string>;
  /** `node`'s type is a type parameter (or another type only an instance
   * resolves), so it has no element key here and may be a native array in
   * an instance (`xs: A` with `A extends readonly T[]`). */
  instanceTyped?(node: ts.Expression): boolean;
  /** For a call of a generic function, method or constructor (its
   * declaration, or one enclosing it, has type parameters): the callee's
   * bodies (a function with a body, or the class a constructor belongs to;
   * null when one is not in the program), and a function that answers the
   * element keys of every native array reachable from the types of the
   * call's arguments, its receiver and its result. Null for any other
   * call. */
  genericCall?(call: ts.CallExpression | ts.NewExpression): {
    bodies: readonly ts.Node[] | null;
    keys(): readonly string[];
  } | null;
  /** Debug provenance for a new fact. */
  note:
    | ((fact: "undefined" | "holes" | "foreign", key: string, site: ts.Node | undefined) => void)
    | null;
  /** The scan read, or added to, the facts of an element key, of an owning
   * slot, or of every array (ANY_ARRAY), for dependency tracking
   * (SiteDependencies). */
  read?(fact: string | ts.Symbol): void;
  changed?(fact: string | ts.Symbol): void;
}

/** The fact name of the facts shared by every array. */
const ANY_ARRAY = "*";
/** The fact name of holes stored through dynamic views. */
const VIEW_HOLES = "%view";
/** The fact name of values stored through dynamic views. */
const VIEW_VALUES = "%view-values";
/** The fact names of "some element key can hold holes" and "some element
 * key can hold undefined". */
const HOLEY_KEYS = "%holey-keys";
const UNDEFINED_KEYS = "%undefined-keys";
/** The fact name of "another function builds arrays from generic ones". */
const BUILDERS = "%generic-builders";

/** Element keys whose arrays store a value written through a dynamic view
 * that the element type cannot hold, as a foreign element: `number[]` and
 * `string[]`. Arrays of other element types reject such a write with the
 * checked conversion's TypeError. */
const FOREIGN_ELEMENT_KEYS: ReadonlySet<string> = new Set(["f64", "string"]);

/** What an array value can contain besides present values. */
interface Contents {
  undefined: boolean;
  holes: boolean;
}

const NOTHING: Contents = { undefined: false, holes: false };
const NO_SOURCES: readonly ts.Expression[] = [];

/** Methods whose callbacks also visit holes, as `undefined`. */
const HOLE_VISITING = new Set(["find", "findIndex", "findLast", "findLastIndex"]);

/** Array methods returning a new array, by what happens to the receiver's
 * holes in it, and methods returning the receiver itself. */
const HOLES_KEPT = new Set(["slice", "splice", "concat"]);
const HOLES_SKIPPED = new Set(["filter", "flat"]);
const HOLES_FILLED = new Set(["toSorted", "toReversed", "toSpliced", "with"]);
const IN_PLACE = new Set(["sort", "reverse", "fill", "copyWithin"]);
/** Methods that store their arguments into the receiver. */
const STORES_ARGUMENTS = new Set(["push", "unshift", "splice", "fill"]);

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
  /** A store through a dynamic value can leave holes; they land in every
   * native array such a value views. */
  private viewHoles = false;
  /** A store through a dynamic value can write any value, which the
   * viewed native arrays then hold as undefined or foreign elements. */
  private viewValues = false;
  private viewKeys: ReadonlySet<string> | null = null;
  /** Facts of arrays owned by one storage slot. */
  private readonly undefinedOwners = new Set<ts.Symbol>();
  private readonly holeyOwners = new Set<ts.Symbol>();

  /** Generic arrays whose elements the arrays of an owning slot were built
   * from (`const ys = xs.slice()` in a generic function), by what the slot's
   * arrays take from them: their undefined values (and their holes, copied
   * as undefined), or their holes. The slot's own facts say nothing about
   * either. */
  private readonly ownerSources = new Map<
    ts.Symbol,
    { undefined: Set<ts.Expression>; holes: Set<ts.Expression> }
  >();
  /** While set, collects the generic arrays the current judgement read:
   * expressions with no element key outside an instance, whose facts are
   * those of each instance's key (sourcesMayHoldMissing). */
  private sources: Set<ts.Expression> | null = null;
  /** Functions and classes whose code builds an array from a generic
   * array's elements or stores them into another array (a spread, a copying
   * method, a rest pattern, a push of a spread), directly or by calling a
   * generic function that does. Code that only reads a generic array, or
   * returns it, is not among them. */
  private readonly genericBuilders = new Set<ts.Node>();
  /** Counts the generic arrays judgements have read, collected or not. */
  private genericReads = 0;
  /** The collector of scan(), reused between sites. */
  private readonly siteSources = new Set<ts.Expression>();
  /** How a generic array is judged: its contents are unknown, or, to find
   * what an array built from it takes from it, it holds nothing missing or
   * both a hole and undefined. */
  private genericArrays: "unknown" | "present" | "missing" = "unknown";

  /** The node being scanned, for provenance notes. */
  private site: ts.Node | undefined;
  /** While set, arrays judged only by their element ABI count as present. */
  private ownFactsOnly = false;

  constructor(private readonly host: ElementStateHost) {}

  /** Every element a callback of `method` receives from `receiver` is a
   * present value. */
  elementsPresent(receiver: ts.Expression, method: string): boolean {
    const reads = this.genericReads;
    const contents = this.contents(receiver);
    if (contents === null || contents.undefined || (HOLE_VISITING.has(method) && contents.holes))
      return false;
    if (this.genericReads === reads) return true;
    // An array built from generic arrays (a slot that owns a copy of one, a
    // literal that spreads one) holds in an instance what they hold there.
    // No instance is known here, so that counts as soon as any array of the
    // program can hold a missing element.
    const built = this.judged(receiver, "missing");
    if (!built.undefined && !(HOLE_VISITING.has(method) && built.holes)) return true;
    this.host.read?.(ANY_ARRAY);
    this.host.read?.(HOLEY_KEYS);
    this.host.read?.(UNDEFINED_KEYS);
    this.host.read?.(VIEW_HOLES);
    this.host.read?.(VIEW_VALUES);
    return !(
      this.anyUndefined ||
      this.anyHoley ||
      this.viewHoles ||
      this.viewValues ||
      this.holeyKeys.size > 0 ||
      this.undefinedKeys.size > 0
    );
  }

  /** The contents of `node` with every generic array judged one way. */
  private judged(node: ts.Expression, generic: "present" | "missing"): Contents {
    const outer = this.genericArrays;
    const sources = this.sources;
    this.genericArrays = generic;
    this.sources = null;
    try {
      return this.contents(node) ?? { undefined: true, holes: true };
    } finally {
      this.genericArrays = outer;
      this.sources = sources;
    }
  }

  /** Null when a for-of loop can bind `undefined` (loopMayYieldUndefined).
   * Otherwise the generic arrays its elements come from: the loop binds
   * `undefined` in an instance where one of them holds a hole or undefined
   * (sourcesMayHoldMissing). Empty for a loop that reads no generic array. */
  loopSources(node: ts.ForOfStatement): readonly ts.Expression[] | null {
    const reads = this.genericReads;
    if (this.loopMayYieldUndefined(node)) return null;
    if (this.genericReads === reads) return NO_SOURCES;
    const sources = new Set<ts.Expression>();
    const outer = this.sources;
    this.sources = sources;
    try {
      this.loopMayYieldUndefined(node);
    } finally {
      this.sources = outer;
    }
    return [...sources];
  }

  /** Arrays with this element key can hold a hole or undefined. */
  keyMayHoldMissing(key: string): boolean {
    const contents = this.stored([key]);
    return contents === null || contents.undefined || contents.holes;
  }

  /** One of `sources` (generic arrays, see loopSources) can hold a hole or
   * undefined under the element key it has where this is asked: inside an
   * instance, whose type-parameter bindings the host's queries resolve. A
   * source that has no key there either (its element type has no mapping
   * for another reason) is judged as the loop was, by the facts every
   * array shares. */
  sourcesMayHoldMissing(sources: readonly ts.Expression[]): boolean {
    for (const source of sources) {
      const keys = this.host.arrayKeys(source);
      if (keys === null || keys.length === 0) continue;
      const contents = this.stored(keys);
      if (contents === null || contents.undefined || contents.holes) return true;
    }
    return false;
  }

  /** Scans one syntax node; true when a fact was added. */
  scan(node: ts.Node): boolean {
    const sources = this.siteSources;
    if (sources.size > 0) sources.clear();
    this.sources = sources;
    let changed: boolean;
    try {
      changed = this.scanFacts(node);
    } finally {
      this.sources = null;
    }
    if (sources.size === 0) return changed;
    // A loop only reads; any other site that judged a generic array's
    // contents built or stored an array from them.
    if (!ts.isForOfStatement(node) && this.noteGenericBuilder(node)) changed = true;
    // What this site stored into an owning slot's array came from generic
    // arrays: the slot is judged with them in each instance.
    const owner = this.writtenOwner(node);
    if (owner === null) return changed;
    // An array built here takes what its contents differ by when the
    // generic arrays hold something missing; a store takes either.
    let takes = { undefined: true, holes: true };
    if (
      (ts.isArrayLiteralExpression(node) ||
        ts.isCallExpression(node) ||
        ts.isNewExpression(node)) &&
      this.host.allocationOwner(node) === owner
    ) {
      const missing = this.judged(node, "missing");
      const present = this.judged(node, "present");
      takes = {
        undefined: missing.undefined && !present.undefined,
        holes: missing.holes && !present.holes,
      };
    }
    let known = this.ownerSources.get(owner);
    if (known === undefined)
      this.ownerSources.set(owner, (known = { undefined: new Set(), holes: new Set() }));
    const before = known.undefined.size + known.holes.size;
    for (const source of sources) {
      if (takes.undefined) known.undefined.add(source);
      if (takes.holes) known.holes.add(source);
    }
    if (known.undefined.size + known.holes.size === before) return changed;
    this.host.changed?.(owner);
    return true;
  }

  /** Marks the functions and classes around `node` as building arrays from
   * generic ones; true when one was not marked yet. */
  private noteGenericBuilder(node: ts.Node): boolean {
    let grew = false;
    for (let outer = node.parent; outer; outer = outer.parent) {
      if (
        !ts.isFunctionLike(outer) &&
        !ts.isClassDeclaration(outer) &&
        !ts.isClassExpression(outer)
      )
        continue;
      if (this.genericBuilders.has(outer)) continue;
      this.genericBuilders.add(outer);
      grew = true;
    }
    if (grew) this.host.changed?.(BUILDERS);
    return grew;
  }

  /** The owning slot whose array `node` builds or stores into. */
  private writtenOwner(node: ts.Node): ts.Symbol | null {
    if (ts.isArrayLiteralExpression(node)) return this.host.allocationOwner(node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const allocated = this.host.allocationOwner(node);
      if (allocated !== null) return allocated;
      const callee = withoutParenthesesTypeWrappers(node.expression);
      return ts.isPropertyAccessExpression(callee) && STORES_ARGUMENTS.has(callee.name.text)
        ? this.host.ownerOf(callee.expression)
        : null;
    }
    if (ts.isBinaryExpression(node)) {
      const target = withoutParenthesesTypeWrappers(node.left);
      if (!ts.isArrayLiteralExpression(target)) return null;
      const last = target.elements.nodes[target.elements.nodes.length - 1];
      return last && ts.isSpreadElement(last) ? this.host.ownerOf(last.expression) : null;
    }
    return null;
  }

  private scanFacts(node: ts.Node): boolean {
    this.site = node;
    if (ts.isBinaryExpression(node)) return this.scanAssignment(node);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      // `xs[i]++` writes index i, and `xs.length++` grows the array.
      const target = withoutParenthesesTypeWrappers(node.operand as ts.Expression);
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
      const target = withoutParenthesesTypeWrappers(node.expression);
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
    const last = pattern.elements.nodes[pattern.elements.nodes.length - 1];
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
    const pattern = withoutParenthesesTypeWrappers(node.left);
    if (!ts.isArrayLiteralExpression(pattern)) return false;
    const last = pattern.elements.nodes[pattern.elements.nodes.length - 1];
    if (!last || !ts.isSpreadElement(last)) return false;
    if (!this.mayYieldUndefined(node.right)) return false;
    return this.addUndefinedTo(last.expression);
  }

  /** Contents of the array `node` evaluates to; null when its element ABI
   * is generic. Arrays the expression creates are judged by how they are
   * built; any other array by the facts of its element ABI. */
  private contents(node: ts.Expression): Contents | null {
    const e = withoutParenthesesTypeWrappers(node);
    if (ts.isArrayLiteralExpression(e)) {
      let undefinedValue = false;
      let holes = false;
      for (const element of e.elements.nodes) {
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
    if (owner !== null) {
      this.host.read?.(owner);
      const own = {
        undefined: this.undefinedOwners.has(owner),
        holes: this.holeyOwners.has(owner),
      };
      // A slot whose array was built from generic arrays also holds what
      // they hold in an instance.
      const built = this.ownerSources.get(owner);
      if (built === undefined) return own;
      this.genericReads++;
      if (this.sources !== null) {
        for (const source of built.undefined) this.sources.add(source);
        for (const source of built.holes) this.sources.add(source);
      }
      if (this.genericArrays !== "missing") return own;
      return {
        undefined: own.undefined || built.undefined.size > 0,
        holes: own.holes || built.holes.size > 0,
      };
    }
    return this.storedIn(e);
  }

  /** The facts recorded for the arrays `node` can evaluate to. A generic
   * array has none here; it is noted as a source for its instances. */
  private storedIn(node: ts.Expression): Contents | null {
    const keys = this.host.arrayKeys(node);
    if (keys === null || (keys.length === 0 && (this.host.instanceTyped?.(node) ?? false))) {
      this.genericReads++;
      this.sources?.add(node);
      if (this.genericArrays === "missing") return { undefined: true, holes: true };
    }
    return this.stored(keys);
  }

  /** Contents of an array a call creates; undefined when the call is not a
   * known array constructor or method. */
  private builtContents(node: ts.CallExpression | ts.NewExpression): Contents | null | undefined {
    const args = node.arguments?.nodes ?? [];
    const callee = withoutParenthesesTypeWrappers(node.expression);
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
      if (method === "all") {
        // Promise.all fulfills with each entry's settled value, so the
        // result holds undefined where an entry is a hole or an undefined
        // value, or where an entry's settled type admits undefined
        // (`Promise<T | undefined>`, whose result stores T elements).
        const source = args[0];
        return {
          undefined:
            source !== undefined &&
            (ts.isSpreadElement(source) ||
              !ts.isCallExpression(node) ||
              (this.host.settledMayBeUndefined?.(node) ?? true) ||
              this.mayYieldUndefined(source) ||
              (this.host.iterationMayYieldUndefined?.(source) ?? false)),
          holes: false,
        };
      }
      // An allSettled outcome can carry a runtime-absent result.
      return method === "allSettled" ? { undefined: true, holes: false } : undefined;
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
      const flattened = this.storedIn(node);
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
        const flattened = this.storedIn(node);
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
    if (this.ownFactsOnly) return NOTHING;
    this.host.read?.(ANY_ARRAY);
    if (keys === null)
      return this.genericArrays === "unknown"
        ? null
        : { undefined: this.anyUndefined, holes: this.anyHoley };
    for (const key of keys) this.host.read?.(key);
    this.host.read?.(VIEW_HOLES);
    this.host.read?.(VIEW_VALUES);
    return {
      undefined:
        this.anyUndefined ||
        keys.some(
          (key) =>
            this.undefinedKeys.has(key) ||
            this.host.elementAdmitsUndefined(key) ||
            this.viewedValues(key),
        ),
      holes: this.anyHoley || keys.some((key) => this.holeyKeys.has(key) || this.viewed(key)),
    };
  }

  /** Holes stored through a dynamic view can be in arrays of this key. */
  private viewed(key: string): boolean {
    return this.viewHoles && this.isViewed(key);
  }

  /** Values of any type stored through a dynamic view can be in arrays of
   * this key. */
  private viewedValues(key: string): boolean {
    return this.viewValues && FOREIGN_ELEMENT_KEYS.has(key) && this.isViewed(key);
  }

  private isViewed(key: string): boolean {
    this.viewKeys ??= this.host.nativeViewKeys();
    return this.viewKeys.has(key) || this.viewKeys.has(ANY_ARRAY);
  }

  /** Element keys whose arrays can hold elements outside their element
   * type, stored through dynamic views (of FOREIGN_ELEMENT_KEYS). Final
   * once the fixed point is reached. */
  foreignKeys(): ReadonlySet<string> {
    if (!this.viewValues) return new Set();
    return new Set([...FOREIGN_ELEMENT_KEYS].filter((key) => this.isViewed(key)));
  }

  /** A store through `receiver`, which has no native element key, can
   * write a value of any type into a viewed native array. */
  private addViewValues(receiver: ts.Expression): boolean {
    if (this.viewValues || !this.host.isDynamicArray(receiver)) return false;
    this.viewValues = true;
    this.host.changed?.(VIEW_VALUES);
    this.host.note?.("foreign", VIEW_VALUES, this.site);
    return true;
  }

  /** A store through `receiver`, which has no native element key, can
   * leave holes. Only a dynamic value can be a view of a native array. */
  private addViewHoles(receiver: ts.Expression): boolean {
    if (this.viewHoles || !this.host.isDynamicArray(receiver)) return false;
    this.viewHoles = true;
    this.host.changed?.(VIEW_HOLES);
    this.host.note?.("holes", VIEW_HOLES, this.site);
    return true;
  }

  /** Reading every index of `node` (a spread, an iteration, `Array.from`)
   * can produce `undefined`. Only native arrays can: other iterables reject
   * an undefined value when it is stored. */
  private mayYieldUndefined(node: ts.Expression): boolean {
    const keys = this.host.arrayKeys(node);
    if (keys !== null && keys.length === 0) {
      // A value typed by a type parameter is an array in some instances.
      if (!(this.host.instanceTyped?.(node) ?? false)) return false;
      this.genericReads++;
      this.sources?.add(node);
      return this.genericArrays === "missing";
    }
    const contents = this.contents(node);
    this.host.read?.(ANY_ARRAY);
    return contents === null
      ? this.anyUndefined || this.anyHoley
      : contents.undefined || contents.holes;
  }

  /** One stored value, or the elements a spread copies. */
  private valueMayBeUndefined(value: ts.Expression): boolean {
    if (ts.isSpreadElement(value))
      return (
        this.mayYieldUndefined(value.expression) ||
        (this.host.iterationMayYieldUndefined?.(value.expression) ?? false)
      );
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
    if (ts.isArrayLiteralExpression(node) && node.elements.nodes.length === 0) return false;
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
      if (changed) this.host.changed?.(owner);
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
    this.host.changed?.(owner);
    return true;
  }

  /** A store through `receiver` can leave holes. */
  private addHolesTo(receiver: ts.Expression): boolean {
    const owner = this.host.ownerOf(receiver);
    if (owner === null) {
      const keys = this.host.arrayKeys(receiver);
      if (keys !== null && keys.length === 0) return this.addViewHoles(receiver);
      return this.addHoles(keys);
    }
    if (this.holeyOwners.has(owner)) return false;
    this.holeyOwners.add(owner);
    this.host.changed?.(owner);
    return true;
  }

  private addUndefined(keys: readonly string[] | null): boolean {
    if (keys === null) {
      if (this.anyUndefined) return false;
      this.anyUndefined = true;
      this.host.changed?.(ANY_ARRAY);
      this.host.note?.("undefined", "*", this.site);
      return true;
    }
    let changed = false;
    for (const key of keys) {
      if (this.undefinedKeys.has(key)) continue;
      if (this.undefinedKeys.size === 0) this.host.changed?.(UNDEFINED_KEYS);
      this.undefinedKeys.add(key);
      this.host.changed?.(key);
      this.host.note?.("undefined", key, this.site);
      changed = true;
    }
    return changed;
  }

  private addHoles(keys: readonly string[] | null): boolean {
    if (keys === null) {
      if (this.anyHoley) return false;
      this.anyHoley = true;
      this.host.changed?.(ANY_ARRAY);
      this.host.note?.("holes", "*", this.site);
      return true;
    }
    let changed = false;
    for (const key of keys) {
      if (this.holeyKeys.has(key)) continue;
      if (this.holeyKeys.size === 0) this.host.changed?.(HOLEY_KEYS);
      this.holeyKeys.add(key);
      this.host.changed?.(key);
      this.host.note?.("holes", key, this.site);
      changed = true;
    }
    return changed;
  }

  /** A generic function's body is judged without its instances' element
   * keys, so what it builds from an argument's elements carries no fact of
   * its own: holes that `map` keeps under another element type, holes that
   * a copy (`[...xs]`, `Array.from`) turns into present undefined
   * elements, elements moved into another argument. When the callee builds
   * arrays from generic ones (genericBuilders) and an array the call can
   * reach may hold holes, every array it can reach, and its result, may
   * hold holes and undefined. Explicit undefined values cross element types
   * only through typed callbacks, judged where they are written. */
  private scanGenericCall(node: ts.CallExpression | ts.NewExpression): boolean {
    const callee = this.host.genericCall?.(node) ?? null;
    if (callee === null) return false;
    this.host.read?.(BUILDERS);
    if (callee.bodies !== null && !callee.bodies.some((body) => this.genericBuilders.has(body)))
      return false;
    // The code around this call builds through the callee.
    const builder = this.noteGenericBuilder(node);
    this.host.read?.(HOLEY_KEYS);
    this.host.read?.(VIEW_HOLES);
    if (this.holeyKeys.size === 0 && !this.viewHoles) return builder;
    const keys = callee.keys();
    for (const key of keys) this.host.read?.(key);
    if (!keys.some((key) => this.holeyKeys.has(key) || this.viewed(key))) return builder;
    const holes = this.addHoles(keys);
    const undefinedValues = this.addUndefined(keys);
    return builder || holes || undefinedValues;
  }

  private scanAssignment(node: ts.BinaryExpression): boolean {
    const op = node.operatorToken.kind;
    if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return false;
    const target = withoutParenthesesTypeWrappers(node.left);
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
      const keys = this.host.arrayKeys(target.expression);
      if (keys !== null && keys.length === 0) {
        // Through a dynamic value: any element write can store a value the
        // viewed native array's element type does not hold.
        if (namesProperty(target)) return false;
        let changed = false;
        if (holes && this.addViewHoles(target.expression)) changed = true;
        if (this.addViewValues(target.expression)) changed = true;
        return changed;
      }
      const undefinedValue = storesValue && this.host.mayBeUndefined(node.right);
      if (!holes && !undefinedValue) return false;
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
      return this.addHolesTo(target.expression);
    }
    return false;
  }

  private scanCall(node: ts.CallExpression | ts.NewExpression): boolean {
    let changed = false;
    const args = node.arguments?.nodes ?? [];
    // Spreading a sparse array, or a tuple with undefined elements, into a
    // rest parameter fills the holes.
    if (args.some((arg) => ts.isSpreadElement(arg))) {
      for (const arg of args) {
        if (!ts.isSpreadElement(arg) || !this.valueMayBeUndefined(arg)) continue;
        const rest = this.host.restKeys(node) ?? this.host.arrayKeys(arg.expression);
        if (this.addUndefined(rest)) changed = true;
      }
    }
    // An argument in a rest position that may be undefined is a present
    // undefined element of the rest array.
    const restStart = this.host.restStart?.(node) ?? null;
    if (restStart !== null)
      for (const arg of args.slice(restStart))
        if (
          !ts.isSpreadElement(arg) &&
          this.host.mayBeUndefined(arg) &&
          this.addUndefined(this.host.restKeys(node))
        )
          changed = true;
    if (this.record(node)) changed = true;
    if (this.scanGenericCall(node)) changed = true;
    const callee = withoutParenthesesTypeWrappers(node.expression);
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
    if (receiver !== null && receiver.length === 0) {
      if (
        (stored.length > 0 || callee.name.text === "fill") &&
        this.addViewValues(callee.expression)
      )
        changed = true;
      return changed;
    }
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
    const owner = withoutParenthesesTypeWrappers(callee.expression);
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
        ts.isPropertyAccessExpression(withoutParenthesesTypeWrappers(owner.expression)) &&
        (withoutParenthesesTypeWrappers(owner.expression) as ts.PropertyAccessExpression).name
          .text === "prototype" &&
        this.host.isGlobal(
          (withoutParenthesesTypeWrappers(owner.expression) as ts.PropertyAccessExpression)
            .expression,
          "Array",
        ));
    if (!reflective) return false;
    let changed = false;
    // The written object: `Reflect.apply`'s receiver argument, otherwise
    // the first argument.
    const written = this.host.isGlobal(owner, "Reflect") && method === "apply" ? 1 : 0;
    for (const [index, arg] of args.entries()) {
      const target = ts.isSpreadElement(arg) ? arg.expression : arg;
      const keys = this.host.arrayKeys(target);
      if (keys !== null && keys.length === 0) {
        if (index === written && this.addViewHoles(target)) changed = true;
        if (index === written && this.addViewValues(target)) changed = true;
        continue;
      }
      if (this.addUndefinedTo(target)) changed = true;
      if (this.addHolesTo(target)) changed = true;
    }
    return changed;
  }

  /** A for-of loop over `node`'s iterable can bind `undefined`: a hole
   * or a stored undefined in the array it walks. When it cannot, every
   * element the loop reads is a present value. */
  loopMayYieldUndefined(node: ts.ForOfStatement): boolean {
    return this.mayYieldUndefined(this.loopSource(node));
  }

  /** The loop's array itself, as built or as owned by one slot, can hold
   * a hole or undefined. Facts shared by every array with the same element
   * ABI are coarser: a loop judged only by them keeps checked reads. */
  private loopHolesKnown(node: ts.ForOfStatement): boolean {
    const source = this.loopSource(node);
    const keys = this.host.arrayKeys(source);
    if (keys !== null && keys.length === 0) return false;
    this.ownFactsOnly = true;
    try {
      const contents = this.contents(source);
      return contents !== null && (contents.undefined || contents.holes);
    } finally {
      this.ownFactsOnly = false;
    }
  }

  private loopSource(node: ts.ForOfStatement): ts.Expression {
    let source = withoutParenthesesTypeWrappers(node.expression);
    if (
      ts.isCallExpression(source) &&
      ts.isPropertyAccessExpression(source.expression) &&
      (source.expression.name.text === "values" || source.expression.name.text === "entries") &&
      source.arguments.nodes.length === 0
    ) {
      const array = source.expression.expression;
      const receiver = this.host.arrayKeys(array);
      if (receiver === null || receiver.length > 0 || (this.host.instanceTyped?.(array) ?? false))
        source = array;
    }
    return source;
  }

  private scanForOf(node: ts.ForOfStatement): boolean {
    if (!this.loopMayYieldUndefined(node)) return false;
    const known = this.loopHolesKnown(node);
    const initializer = node.initializer;
    let changed = false;
    const mark = (name: ts.Node): void => {
      if (ts.isIdentifier(name)) {
        if (this.host.markIterationBinding(name, known)) changed = true;
        return;
      }
      ts.forEachChild(name, mark);
    };
    if (ts.isVariableDeclarationList(initializer)) {
      for (const declaration of initializer.declarations.nodes) mark(declaration.name);
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
  const callee = withoutParenthesesTypeWrappers(node.expression);
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
    const callback = parent.parent.arguments.nodes[0];
    return (
      callback !== undefined &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters.nodes.length <= arrayAt &&
      !callback.parameters.nodes.some((parameter) => parameter.dotDotDotToken) &&
      ts.isArrowFunction(callback)
    );
  }
  return false;
}

function merge(a: Contents | null, b: Contents | null): Contents | null {
  if (a === null || b === null) return null;
  return { undefined: a.undefined || b.undefined, holes: a.holes || b.holes };
}

function sameReference(a: ts.Expression, b: ts.Expression): boolean {
  const left = withoutParenthesesTypeWrappers(a);
  const right = withoutParenthesesTypeWrappers(b);
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) return left.text === right.text;
  if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword)
    return true;
  if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(right))
    return left.name.text === right.name.text && sameReference(left.expression, right.expression);
  return false;
}

/** `xs[xs.length] = v` appends without leaving a hole. */
function isAppendIndex(target: ts.ElementAccessExpression): boolean {
  const index = withoutParenthesesTypeWrappers(target.argumentExpression);
  return (
    ts.isPropertyAccessExpression(index) &&
    index.name.text === "length" &&
    sameReference(index.expression, target.expression)
  );
}

/** `o["name"]`: a string literal key that is not an array index writes a
 * named property, never an element. */
function namesProperty(target: ts.ElementAccessExpression): boolean {
  const key = withoutParenthesesTypeWrappers(target.argumentExpression);
  if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return false;
  return !/^(0|[1-9][0-9]*)$/.test(key.text) || Number(key.text) >= 2 ** 32 - 1;
}

/** `xs.length = 0`, `xs.length = xs.length - k` and `xs.length -= k`
 * truncate; truncation never leaves holes. */
function isShrinkingLength(
  node: ts.BinaryExpression,
  target: ts.PropertyAccessExpression,
): boolean {
  const op = node.operatorToken.kind;
  const right = withoutParenthesesTypeWrappers(node.right);
  if (op === ts.SyntaxKind.MinusEqualsToken) return ts.isNumericLiteral(right);
  if (op !== ts.SyntaxKind.EqualsToken) return false;
  if (ts.isNumericLiteral(right)) return Number(right.text) === 0;
  if (!ts.isBinaryExpression(right) || right.operatorToken.kind !== ts.SyntaxKind.MinusToken)
    return false;
  const length = withoutParenthesesTypeWrappers(right.left);
  return (
    ts.isNumericLiteral(withoutParenthesesTypeWrappers(right.right)) &&
    ts.isPropertyAccessExpression(length) &&
    length.name.text === "length" &&
    sameReference(length.expression, target.expression)
  );
}

function isNumberLike(node: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(node);
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
