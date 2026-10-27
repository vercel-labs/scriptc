/* Int32[] contracts: every present element of an array that can reach an
 * `Int32[]` slot is an int32.
 *
 * The contract is about arrays, not slots: whoever writes an array that is
 * (or later becomes) the value of an `Int32[]` slot must store int32s,
 * through any reference to it. The check therefore works on the flow of
 * array references through the whole program. Nodes are the places an
 * array can live, keyed by IR names like int32-slots.ts keys:
 *
 *   l:<fn>\0<local>  locals and parameters (captured bindings link both ways)
 *   g:<global>       module globals
 *   r:<fn>           function results
 *   f:<family>       class field families
 *   s:<shape>\0<f>   record fields (`*`: the index signature's entries)
 *   e:/mk:/mv:/se:<container type>  elements, map keys and values, set
 *                    elements of every container of that type
 *
 * plus one node per allocation (an array literal, a length-only array) and
 * one per opaque origin (a caller scriptc cannot see, dynamic code, a
 * library result). Every IR store adds an edge from the stored value's
 * nodes to the slot; an operation that copies elements from one array into
 * another (spreads, `concat`, `slice`, splice items) links their nodes as
 * if both were the same array, which over-approximates both directions.
 *
 * - The allocations that can reach an annotated slot are constrained: every
 *   element store into an array from one of them, wherever it happens, must
 *   be an int32 by construction (the same integer range proofs as Int32,
 *   with the elements of other Int32[] arrays assumed int32: sound by
 *   induction). An opaque origin that can reach an annotated slot refuses
 *   the contract (SC7003): its arrays were filled by code scriptc does not
 *   check.
 * - A slot that can hold a constrained array is checked; such a value may
 *   not flow anywhere the IR does not show (dynamic code, function values,
 *   library calls that are not read-only, throws, promises) (SC7003).
 * - A slot that no unconstrained allocation and no opaque origin can reach
 *   holds only constrained arrays: an element read through it that finds a
 *   value reads an int32. Those slots are recorded as
 *   IrContracts.int32Elements.
 *
 * Holes, present undefined, out-of-range reads and `length` changes keep
 * their JavaScript behavior: the contract constrains the values stored, not
 * the array's shape. */
import type { DiagnosticCode } from "../diagnostics/codes.js";
import type { ContractNote, ContractAnnotations } from "../frontend/contract-types.js";
import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  SrcLoc,
} from "../ir/ir.js";
import { typeKey } from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";
import { functionCallFacts, int32ElementSlot, Int32Slots } from "../ir/int32-slots.js";

/** What the Int32[] check needs from the contract checker. */
export interface ElementContractHost {
  readonly mod: IrModule;
  readonly notes: ContractAnnotations;
  readonly functions: ReadonlyMap<string, IrFunction>;
  readonly classes: ReadonlyMap<string, IrClassDef>;
  report(code: DiagnosticCode, loc: SrcLoc, message: string, hint: string): void;
  text(loc: SrcLoc, max?: number): string;
  where(loc: SrcLoc | null): string;
  displayName(fnName: string): string;
  bindingsOf(key: string): { fn: IrFunction | null; id: string }[];
  functionsAt(key: string): readonly IrFunction[];
  classesAt(key: string): readonly IrClassDef[];
}

/** An element store into a number array, checked once ranges are known. */
interface ElementWrite {
  fn: IrFunction;
  /** The nodes of the array written. */
  target: string[];
  /** The stored number. */
  value: IrExpr;
  /** Source text of the written array, for messages. */
  arrayText: string;
  /** An element of an array literal. */
  literal?: true;
  /** The written array expression (element stores and methods). */
  arr?: IrExpr;
}

/** A value leaving the IR's sight, with the nodes it can hold. */
interface Escape {
  nodes: string[];
  loc: SrcLoc;
  shown: string;
  what: string;
}

/** Array methods that store their numeric arguments as elements, by the
 * argument positions they store. */
const ELEMENT_ARGS: ReadonlyMap<string, "all" | number> = new Map<string, "all" | number>([
  ["push", "all"],
  ["unshift", "all"],
  ["fill", 0],
  ["with", 1],
]);

const NO_NODES: ReadonlySet<string> = new Set();

/** Array methods whose result is a new array holding copies of the
 * receiver's (and array arguments') elements. */
const COPIES = new Set([
  "slice",
  "splice",
  "concatSpread",
  "toSpliced",
  "toReversed",
  "toSortedPrimitive",
  "with",
  "withUndefined",
]);

/** Array methods that copy the elements of an array argument into the
 * receiver. */
const COPY_IN = new Set(["pushSpread", "unshiftSpread", "spliceInsert"]);

/** Library calls that only read array arguments. */
const READ_ONLY_LIB =
  /^(console\.|inspect\.|json\.stringify|math\.|insp\.|array\.(hasProperties|namedKeys|hasNamedKey)$)/;

/** Library calls that always throw (the value they stand for never exists). */
const THROWING_LIB = /^error\.\w*Throw$/;

/** Expression kinds whose array result is one of their operands. */
const PASS_THROUGH = new Set<IrExpr["kind"]>([
  "upcast",
  "downcast",
  "unionWrap",
  "unionRetype",
  "unionNarrow",
  "ternary",
  "logical",
  "nullish",
  "orDefault",
  "seqExpr",
  "chainRecv",
  "optChain",
  "assignExpr",
]);

/** Kinds that only inspect an array operand (identity, truthiness, text). */
const OBSERVE = new Set<IrExpr["kind"]>([
  "toBool",
  "strEq",
  "unionEq",
  "unionFuncEq",
  "unionIsTag",
  "unionDisc",
  "instanceOf",
  "instanceOfValue",
  "dynScalarEq",
  "fieldAbsent",
  "recordHas",
  "recordOvfHas",
  "recordNullProto",
  "arrayHas",
  "arrayState",
  "jsonStringify",
  "toString",
  "strConcat",
  "bin",
  "unary",
  "unionKeyGet",
  "recordKeyGet",
  "recordOvfKeys",
  "fieldGet",
  "recordGet",
  "arrayGet",
]);

export class Int32ElementContracts {
  /** Annotated slots and their notes. */
  private readonly annotated = new Map<string, ContractNote>();
  private readonly succ = new Map<string, Set<string>>();
  private readonly pred = new Map<string, Set<string>>();
  /** Element copies: the nodes of the arrays whose elements are copied,
   * and the nodes of the array they are copied into. A copy holds none of
   * its source's references, but the source of a copy into a constrained
   * array must be constrained too. */
  private readonly copies: { from: string[]; to: string[] }[] = [];
  /** Allocation nodes (`a:<n>`) and opaque origins (`o:<n>`). */
  private readonly allocs = new Set<string>();
  private readonly opaque = new Map<string, { loc: SrcLoc; why: string }>();
  private readonly writes: ElementWrite[] = [];
  private readonly escapes: Escape[] = [];
  private readonly slots: Int32Slots;
  private nextNode = 0;
  /** Nodes that may hold a constrained array, with the note it reaches. */
  private readonly constrainedReach = new Map<string, ContractNote>();
  /** Nodes that may hold an unconstrained or opaque array. */
  private readonly unconstrainedReach = new Set<string>();
  private readonly containedMemo = new Map<string, string[]>();
  private readonly unions: ReadonlyMap<string, IrType[]>;
  private readonly records: ReadonlyMap<string, IrRecordShape>;
  private readonly methodImpls = new Map<string, string[]>();
  private readonly subclasses = new Map<string, string[]>();
  /** Functions whose callers are not all visible. */
  private valueEscaped: ReadonlySet<string> = new Set();
  private runtimeVirtual: (name: string) => boolean = () => false;

  constructor(private readonly c: ElementContractHost) {
    this.slots = new Int32Slots(c.classes);
    this.unions = new Map((c.mod.unions ?? []).map((u) => [u.id, u.arms]));
    this.records = new Map((c.mod.records ?? []).map((r) => [r.id, r]));
    for (const cls of c.classes.values()) {
      for (const m of cls.methods ?? []) push(this.methodImpls, m, `%${cls.name}.${m}`);
      if (cls.base) push(this.subclasses, cls.base, cls.name);
    }
  }

  /** Whether any Int32[] annotation exists. */
  get active(): boolean {
    return this.annotated.size > 0;
  }

  /** Bind the annotations, build the flow graph and compute which slots
   * hold constrained arrays. Reports structural refusals. */
  analyze(): void {
    this.bind();
    if (this.annotated.size === 0) return;
    const calls = functionCallFacts(this.c.mod, this.c.classes, (name) => this.subtree(name));
    this.valueEscaped = calls.valueEscaped;
    this.runtimeVirtual = calls.runtimeVirtual;
    for (const fn of this.c.mod.functions) this.scanFunction(fn);
    this.solve();
  }

  /** Whether reads of `arr` inside `fnName` find only int32 elements. */
  readsInt32(fnName: string, arr: IrExpr): boolean {
    const key = int32ElementSlot(fnName, arr, (cls, field) => this.slots.family(cls, field));
    return key !== null && this.int32Slots.has(key);
  }

  /** Slots recorded as IrContracts.int32Elements. */
  readonly int32Slots = new Set<string>();

  private readonly readers = new Map<string, number | null>();
  private readonly localWrites = new Map<string, Map<string, IrExpr[] | null>>();

  /** Whether the number `e` is an element an Int32[] read found: the number
   * arm of an ordinary `xs[i]` read (the lowering's element-read helper
   * returns `number | undefined`, and the read narrows it, throwing for
   * undefined), directly or through a local holding such reads. `int32`
   * answers the range proof for any other number. */
  provenElement(fn: IrFunction, e: IrExpr, int32: (e: IrExpr) => boolean): boolean {
    if (this.int32Slots.size === 0) return false;
    const value = (x: IrExpr, depth: number): boolean => {
      if (int32(x)) return true;
      if (depth > 8) return false;
      if (x.kind === "ternary") return arm(x.then, depth + 1) && arm(x.else_, depth + 1);
      if (x.kind === "unionNarrow") return holder(x.value, depth + 1);
      return false;
    };
    const arm = (x: IrExpr, depth: number): boolean =>
      (x.kind === "libCall" && THROWING_LIB.test(x.fn)) || value(x, depth);
    const holder = (x: IrExpr, depth: number): boolean => {
      if (depth > 8) return false;
      switch (x.kind) {
        case "call": {
          const k = this.elementReader(x.callee);
          const arr = k === null ? undefined : x.args[k];
          return arr !== undefined && this.readsInt32(fn.name, arr);
        }
        case "varRef": {
          const writes = this.writesOf(fn).get(x.localId);
          return (
            writes !== undefined &&
            writes !== null &&
            writes.length > 0 &&
            writes.every((w) => holder(w, depth + 1))
          );
        }
        case "unionWrap":
          return x.value.kind === "unitLit" || value(x.value, depth + 1);
        case "unitLit":
          return true;
        case "ternary":
          return holder(x.then, depth + 1) && holder(x.else_, depth + 1);
        default:
          return false;
      }
    };
    return value(e, 0);
  }

  /** Whether `value` is an element of the written array itself, or of a
   * copy of it the function took (the lowered `sort` moves elements
   * through such a snapshot): storing it adds no new value to the array,
   * whatever its contents. Both must be locals the function never
   * reassigns. */
  private movedWithin(fn: IrFunction, arr: IrExpr, value: IrExpr): boolean {
    if (arr.kind !== "varRef" || value.kind !== "arrayGet" || value.arr.kind !== "varRef")
      return false;
    const writes = this.writesOf(fn);
    const target = arr.localId;
    const source = value.arr.localId;
    const fixed = (id: string): boolean => {
      const list = writes.get(id);
      if (list === null || !fn.locals.some((l) => l.id === id)) return false;
      const isParam = fn.params.some((p) => p.localId === id);
      return isParam ? list === undefined : list !== undefined && list.length === 1;
    };
    if (!fixed(target)) return false;
    if (source === target) return true;
    if (!fixed(source)) return false;
    const init = writes.get(source)?.[0];
    return (
      init !== undefined &&
      init.kind === "arrIntrinsic" &&
      init.method === "slice" &&
      init.receiver.kind === "varRef" &&
      init.receiver.localId === target &&
      this.onlyMoves(fn, source, target, init)
    );
  }

  /** Whether the function uses the snapshot local `source` only to read,
   * reorder and move its own elements (or the target's): then every value
   * it holds is one of the target's elements. */
  private onlyMoves(fn: IrFunction, source: string, target: string, init: IrExpr): boolean {
    const allowed = new Set<IrExpr>();
    const isRef = (e: IrExpr, id: string): boolean => e.kind === "varRef" && e.localId === id;
    const moved = (v: IrExpr): boolean =>
      v.kind === "arrayGet" && (isRef(v.arr, source) || isRef(v.arr, target));
    let ok = true;
    const expr = (e: IrExpr): boolean => {
      if (
        (e.kind === "arrayGet" || e.kind === "arrayState" || e.kind === "arrayHas") &&
        isRef(e.arr, source)
      )
        allowed.add(e.arr);
      else if (
        e.kind === "arrIntrinsic" &&
        isRef(e.receiver, source) &&
        ["length", "nextPresent", "sortValues", "sortDense", "reverse", "copyWithin"].includes(
          e.method,
        )
      )
        allowed.add(e.receiver);
      else if (e.kind === "varRef" && e.localId === source && !allowed.has(e)) ok = false;
      return ok && everyExprChild(e, expr, stmt);
    };
    const stmt = (st: IrStmt): boolean => {
      if (
        (st.kind === "arraySet" && isRef(st.arr, source) && moved(st.value)) ||
        ((st.kind === "arraySetUndefined" || st.kind === "arraySetLength") && isRef(st.arr, source))
      )
        allowed.add(st.arr);
      else if (st.kind === "varDecl" && st.localId === source && st.init !== init) ok = false;
      return ok && everyStmtChild(st, expr, stmt);
    };
    for (const st of fn.body) if (!stmt(st)) break;
    return ok;
  }

  /** The parameter whose element every return of `fnName` reads (or
   * undefined): the lowering's `xs[i]` helper. Null for other functions. */
  private elementReader(fnName: string): number | null {
    const known = this.readers.get(fnName);
    if (known !== undefined) return known;
    this.readers.set(fnName, null);
    const fn = this.c.functions.get(fnName);
    if (!fn || fn.captures?.length || fn.async || fn.generator) return null;
    let result: number | null = null;
    for (let k = 0; k < fn.params.length && result === null; k++) {
      const id = fn.params[k]!.localId;
      if (this.writesOf(fn).get(id) !== undefined) continue;
      const element = (x: IrExpr): boolean => {
        switch (x.kind) {
          case "ternary":
            return element(x.then) && element(x.else_);
          case "arrayGet":
            return x.arr.kind === "varRef" && x.arr.localId === id;
          case "unitLit":
            return true;
          case "unionWrap":
          case "upcast":
            return element(x.value);
          default:
            return false;
        }
      };
      let returns = 0;
      let ok = true;
      const visit = (st: IrStmt): boolean => {
        if (st.kind === "return") {
          returns++;
          if (!st.value || !element(st.value)) ok = false;
        }
        return everyStmtChild(st, () => true, visit);
      };
      for (const st of fn.body) visit(st);
      if (ok && returns > 0) result = k;
    }
    this.readers.set(fnName, result);
    return result;
  }

  /** Every value written to each local of `fn` (null: a write whose value
   * is not an expression, such as `++` or a for-of binding). */
  private writesOf(fn: IrFunction): Map<string, IrExpr[] | null> {
    const known = this.localWrites.get(fn.name);
    if (known) return known;
    const out = new Map<string, IrExpr[] | null>();
    const add = (id: string, value: IrExpr | null): void => {
      const list = out.get(id);
      if (list === null) return;
      if (value === null) out.set(id, null);
      else if (list) list.push(value);
      else out.set(id, [value]);
    };
    for (const l of fn.locals) if (l.boxed) out.set(l.id, null);
    for (const cap of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])])
      out.set(cap.localId, null);
    const expr = (e: IrExpr): boolean => {
      if (e.kind === "assignExpr") add(e.localId, e.value);
      else if (e.kind === "incDec") add(e.localId, null);
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (st: IrStmt): boolean => {
      if (st.kind === "varDecl" && st.init) add(st.localId, st.init);
      else if (st.kind === "assign") add(st.localId, st.value);
      else if (st.kind === "forOf") add(st.localId, null);
      else if (st.kind === "tryCatch" && st.catchLocalId !== null) add(st.catchLocalId, null);
      return everyStmtChild(st, expr, stmt);
    };
    for (const st of fn.body) stmt(st);
    this.localWrites.set(fn.name, out);
    return out;
  }

  /** Check every element store into a constrained array, given an int32
   * test for the stored value inside its function. */
  checkWrites(int32: (fn: IrFunction, value: IrExpr) => boolean): void {
    for (const w of this.writes) {
      const note = this.reachingNote(w.target);
      if (note === undefined || int32(w.fn, w.value)) continue;
      if (w.arr !== undefined && this.movedWithin(w.fn, w.arr, w.value)) continue;
      const at = this.displayed(w.fn, w.value);
      const shown = this.c.text(at);
      // A store inside a lowered array method (`map`, `from`) carries the
      // method call's location for both the array and the value.
      const builtIn = shown !== "" && shown === w.arrayText;
      const what = w.literal
        ? `the array literal element${shown ? ` '${shown}'` : ""} is not provably an int32`
        : builtIn
          ? `the elements '${shown}' stores are not provably int32s`
          : `the element stored into ${w.arrayText ? `'${w.arrayText}'` : "an array"} is not provably an int32${shown ? `: '${shown}'` : ""}`;
      this.c.report(
        "SC7002",
        at,
        `${what} (the array can reach '${note.name}', declared Int32[])`,
        builtIn
          ? "callback results are not followed; build the array with a loop that stores 'value | 0'"
          : shown
            ? `make the int32 conversion explicit, for example '${orZero(shown)}', so Node stores the same value`
            : "make the int32 conversion explicit with '| 0', so Node stores the same value",
      );
    }
  }

  /** The source location that shows a stored value. An element read
   * stored as is (`a[i] = b[j]`) lowers to a narrowing of a temporary that
   * carries the whole statement's location; show the read instead. */
  private displayed(fn: IrFunction, value: IrExpr): SrcLoc {
    let e = value;
    for (let depth = 0; depth < 4; depth++) {
      if (e.kind === "ternary") e = e.then;
      else if (e.kind === "unionNarrow") e = e.value;
      else if (e.kind === "varRef") {
        const writes = this.writesOf(fn).get(e.localId);
        if (!writes || writes.length !== 1) break;
        e = writes[0]!;
      } else break;
      if (e.loc.start > value.loc.start || e.loc.end < value.loc.end) return e.loc;
    }
    return value.loc;
  }

  /** Functions with element stores to check. */
  functionsWithWrites(): Set<string> {
    const out = new Set<string>();
    for (const w of this.writes) if (this.reachingNote(w.target) !== undefined) out.add(w.fn.name);
    return out;
  }

  /* ── binding ── */

  private bind(): void {
    this.bindAnnotations();
    // Messages name the first annotation an array reaches: prefer module
    // bindings and fields over parameters and results.
    const rank = (slot: string): number =>
      slot.startsWith("g:") ? 0 : slot.startsWith("f:") ? 1 : slot.startsWith("l:") ? 2 : 3;
    const ordered = [...this.annotated].sort((a, b) => rank(a[0]) - rank(b[0]));
    this.annotated.clear();
    for (const [slot, note] of ordered) this.annotated.set(slot, note);
  }

  private bindAnnotations(): void {
    const c = this.c;
    const refuse = (note: ContractNote, why: string, hint: string): void =>
      c.report(
        "SC7003",
        note.loc,
        `the Int32[] contract on '${note.name}' cannot be checked: ${why}`,
        hint,
      );
    const numberArray = (t: IrType | undefined): boolean =>
      t !== undefined && t.kind === "array" && t.elem.kind === "f64";
    for (const [key, list] of c.notes.functions)
      for (const note of list) {
        if (note.marker !== "Int32" || note.elements !== true) continue;
        for (const fn of c.functionsAt(key)) {
          if (fn.async === true || fn.generator !== undefined) {
            refuse(
              note,
              "async functions and generators return promises or iterators",
              "annotate the awaited value where it is stored instead",
            );
            continue;
          }
          if (!numberArray(fn.returnType)) {
            refuse(note, "the result is not a plain number array", "declare it as Int32[]");
            continue;
          }
          this.annotated.set(`r:${fn.name}`, note);
        }
      }
    for (const [key, note] of c.notes.bindings) {
      if (note.marker !== "Int32" || note.elements !== true) continue;
      for (const b of c.bindingsOf(key)) {
        const type = b.fn
          ? b.fn.locals.find((l) => l.id === b.id)?.type
          : c.mod.globals?.find((g) => g.id === b.id)?.type;
        if (!numberArray(type)) {
          refuse(
            note,
            "the binding is not a plain number array (optional and union types are not checked)",
            "declare it as a required Int32[]",
          );
          continue;
        }
        this.annotated.set(b.fn ? `l:${b.fn.name}\0${b.id}` : `g:${b.id}`, note);
      }
    }
    for (const [key, note] of c.notes.fields) {
      if (note.marker !== "Int32" || note.elements !== true) continue;
      const cut = key.lastIndexOf("\0");
      const field = key.slice(cut + 1);
      for (const cls of c.classesAt(key.slice(0, cut))) {
        const def = cls.fields.find((f) => f.name === field);
        const family = this.slots.family(cls.name, field);
        if (!def || family === null) {
          refuse(
            note,
            `the compiled class has no field '${field}'`,
            "annotate an ordinary instance field",
          );
          continue;
        }
        if (!numberArray(def.type)) {
          refuse(
            note,
            "the field is not a plain number array",
            "declare the field as a required Int32[]",
          );
          continue;
        }
        this.annotated.set(`f:${family}`, note);
      }
    }
  }

  private subtree(name: string): string[] {
    const out: string[] = [];
    const stack = [name];
    while (stack.length) {
      const next = stack.pop()!;
      out.push(next);
      for (const child of this.subclasses.get(next) ?? []) stack.push(child);
    }
    return out;
  }

  /* ── types ── */

  /** A number array, or a union with a number-array arm: values whose
   * identity the graph follows. */
  private direct(t: IrType): boolean {
    if (t.kind === "array") return t.elem.kind === "f64";
    if (t.kind === "union")
      return (this.unions.get(t.unionId) ?? []).some(
        (a) => a.kind === "array" && a.elem.kind === "f64",
      );
    return false;
  }

  /** The container slots holding number arrays that a value of type `t`
   * can reach through fields and elements. */
  private contained(t: IrType): string[] {
    const key = typeKey(t);
    const memo = this.containedMemo.get(key);
    if (memo) return memo;
    const out = new Set<string>();
    this.containedMemo.set(key, []);
    const add = (slot: string, inner: IrType): void => {
      if (this.direct(inner)) out.add(slot);
      for (const s of this.contained(inner)) out.add(s);
    };
    switch (t.kind) {
      case "array":
        add(`e:${key}`, t.elem);
        break;
      case "set":
        add(`se:${key}`, t.elem);
        break;
      case "map":
        add(`mk:${key}`, t.key);
        add(`mv:${key}`, t.value);
        break;
      case "promise":
        add(`p:${key}`, t.inner);
        break;
      case "union":
        for (const arm of this.unions.get(t.unionId) ?? [])
          for (const s of this.contained(arm)) out.add(s);
        break;
      case "record": {
        const shape = this.records.get(t.shapeId);
        for (const f of shape?.fields ?? []) add(`s:${t.shapeId}\0${f.name}`, f.type);
        if (shape?.indexValue) add(`s:${t.shapeId}\0*`, shape.indexValue);
        break;
      }
      case "object":
        for (const name of this.subtree(t.className)) {
          const cls = this.c.classes.get(name);
          for (const f of cls?.fields ?? []) {
            const family = this.slots.family(name, f.name);
            if (family !== null) add(`f:${family}`, f.type);
          }
        }
        break;
      default:
        break;
    }
    const list = [...out];
    this.containedMemo.set(key, list);
    return list;
  }

  private holds(t: IrType): boolean {
    return this.direct(t) || this.contained(t).length > 0;
  }

  /* ── graph ── */

  private edge(from: string, to: string): void {
    if (from === to) return;
    let s = this.succ.get(from);
    if (!s) this.succ.set(from, (s = new Set()));
    s.add(to);
    let p = this.pred.get(to);
    if (!p) this.pred.set(to, (p = new Set()));
    p.add(from);
  }

  private copy(from: readonly string[], to: readonly string[]): void {
    if (from.length > 0 && to.length > 0) this.copies.push({ from: [...from], to: [...to] });
  }

  private newOpaque(loc: SrcLoc, why: string): string {
    const node = `o:${this.nextNode++}`;
    this.opaque.set(node, { loc, why });
    return node;
  }

  /** An origin the IR does not show produces a value of type `t`. */
  private opaqueValue(t: IrType, loc: SrcLoc, why: string): string[] {
    const node = this.newOpaque(loc, why);
    for (const slot of this.contained(t)) this.edge(node, slot);
    return this.direct(t) ? [node] : [];
  }

  private store(sources: readonly string[], slot: string): void {
    for (const s of sources) this.edge(s, slot);
  }

  private localSlot(fn: IrFunction, id: string): string {
    return id.startsWith("%g.") ? `g:${id}` : `l:${fn.name}\0${id}`;
  }

  private scanFunction(fn: IrFunction): void {
    const c = this.c;
    const chains = new Map<string, IrExpr>();
    const memo = new Map<IrExpr, string[]>();
    // Optional-chain receivers, by chain id, before any read of one.
    const findChains = (e: IrExpr): boolean => {
      if (e.kind === "optChain") chains.set(e.id, e.receiver);
      return everyExprChild(e, findChains, findChainsIn);
    };
    const findChainsIn = (st: IrStmt): boolean => everyStmtChild(st, findChains, findChainsIn);
    for (const st of fn.body) findChainsIn(st);
    // Parameters whose callers are not all visible hold opaque arrays.
    const runtimeVirtual = this.runtimeVirtual;
    if (this.valueEscaped.has(fn.name) || runtimeVirtual(fn.name))
      for (const p of fn.params)
        if (this.holds(p.type)) {
          const why = this.valueEscaped.has(fn.name)
            ? `the callers of '${c.displayName(fn.name)}', which is used as a value (its callers are not all visible)`
            : `the runtime, which calls '${c.displayName(fn.name)}'`;
          for (const node of this.opaqueValue(p.type, fn.loc, why))
            this.edge(node, this.localSlot(fn, p.localId));
        }

    /** The nodes an expression's array value can come from. */
    const sources = (e: IrExpr): string[] => {
      if (!this.direct(e.type)) return [];
      const known = memo.get(e);
      if (known) return known;
      memo.set(e, []);
      const out = sourcesOf(e);
      memo.set(e, out);
      return out;
    };
    const elementSlot = (container: IrExpr): string[] => {
      const t = container.type;
      if (t.kind === "array" && this.direct(t.elem)) return [`e:${typeKey(t)}`];
      return [];
    };
    const sourcesOf = (e: IrExpr): string[] => {
      switch (e.kind) {
        case "varRef":
          return [this.localSlot(fn, e.localId)];
        case "fieldGet": {
          const family = this.slots.family(e.className, e.field);
          return family === null
            ? this.opaqueValue(e.type, e.loc, "a field scriptc cannot follow")
            : [`f:${family}`];
        }
        case "recordGet":
          return [`s:${e.shapeId}\0${e.field}`];
        case "recordKeyGet": {
          const t = e.obj.type;
          if (t.kind !== "record") return this.opaqueValue(e.type, e.loc, "a dynamic property");
          const shape = this.records.get(t.shapeId);
          const out = [`s:${t.shapeId}\0*`];
          for (const f of shape?.fields ?? [])
            if (this.direct(f.type)) out.push(`s:${t.shapeId}\0${f.name}`);
          return out;
        }
        case "arrayGet":
          return elementSlot(e.arr);
        case "mapIntrinsic":
          if (e.method === "get" || e.method === "iterValue")
            return [`mv:${typeKey(e.receiver.type)}`];
          if (e.method === "iterKey") return [`mk:${typeKey(e.receiver.type)}`];
          // Any other result is a stored key or value, or a fresh array.
          return [
            `mv:${typeKey(e.receiver.type)}`,
            `mk:${typeKey(e.receiver.type)}`,
            ...this.opaqueValue(e.type, e.loc, `Map.${e.method}`),
          ];
        case "setIntrinsic":
          if (e.method === "iterKey") return [`se:${typeKey(e.receiver.type)}`];
          return [
            `se:${typeKey(e.receiver.type)}`,
            ...this.opaqueValue(e.type, e.loc, `Set.${e.method}`),
          ];
        case "call":
          return c.functions.has(e.callee)
            ? [`r:${e.callee}`]
            : this.opaqueValue(e.type, e.loc, `a call to '${e.callee}'`);
        case "virtualCall": {
          const impls = this.methodImpls.get(e.method) ?? [];
          return impls.length > 0 ? impls.map((impl) => `r:${impl}`) : unknown(e);
        }
        case "arrayLit":
        case "arrayNewLen":
          return [alloc()];
        case "arrIntrinsic": {
          if (COPIES.has(e.method)) {
            // A new array of copied elements.
            const node = alloc();
            for (const part of [e.receiver, ...e.args])
              this.copy([...sources(part), ...elementSlot(part)], [node]);
            return [node];
          }
          if (e.method === "flatCopy" || e.method === "flatOne") {
            // Copies (or flattens) the receiver into the supplied array,
            // which it returns.
            const into = e.args.flatMap((a) => sources(a));
            this.copy([...sources(e.receiver), ...elementSlot(e.receiver)], into);
            return into;
          }
          // The receiver itself (fill, reverse, sort) or one of its elements.
          return [...sources(e.receiver), ...elementSlot(e.receiver)];
        }
        case "upcast":
        case "downcast":
        case "unionWrap":
        case "unionRetype":
        case "unionNarrow":
        case "assignExpr":
          return sources(e.value);
        case "ternary":
          return [...sources(e.then), ...sources(e.else_)];
        case "logical":
        case "nullish":
        case "orDefault":
          return [...sources(e.left), ...sources(e.right)];
        case "seqExpr":
          return sources(e.result);
        case "optChain":
          return sources(e.body);
        case "chainRecv": {
          const receiver = chains.get(e.id);
          return receiver
            ? sources(receiver)
            : this.opaqueValue(e.type, e.loc, "an optional chain");
        }
        case "unitLit":
          return [];
        default:
          return unknown(e);
      }
    };
    const alloc = (): string => {
      const node = `a:${this.nextNode++}`;
      this.allocs.add(node);
      return node;
    };
    /** An operation scriptc does not follow: a fresh array of unknown
     * contents, or any array its operands hold or reach. */
    const unknown = (e: IrExpr): string[] => {
      const out = this.opaqueValue(e.type, e.loc, describe(e));
      everyExprChild(
        e,
        (child) => {
          out.push(...sources(child), ...this.contained(child.type));
          return true;
        },
        () => true,
      );
      return out;
    };

    const escape = (value: IrExpr, at: SrcLoc, what: string): void => {
      if (!this.holds(value.type)) return;
      const nodes = [...sources(value), ...this.contained(value.type)];
      if (nodes.length > 0) this.escapes.push({ nodes, loc: at, shown: c.text(value.loc), what });
    };
    const write = (arr: IrExpr, value: IrExpr): void => {
      this.writes.push({ fn, target: sources(arr), value, arrayText: c.text(arr.loc), arr });
    };
    const args = (callee: string, list: IrExpr[], offset: number, at: SrcLoc): void => {
      const target = c.functions.get(callee);
      list.forEach((arg, i) => {
        if (!this.holds(arg.type)) return;
        const param = target?.params[i + offset];
        if (!target || !param) {
          escape(arg, at, `a call to '${c.displayName(callee)}'`);
          return;
        }
        this.store(sources(arg), this.localSlot(target, param.localId));
      });
    };
    const isNumberArray = (t: IrType): boolean => t.kind === "array" && t.elem.kind === "f64";

    // Live views handed straight to a read-only library call (util.inspect
    // of an array with properties) are only read through.
    const readOnlyViews = new Set<IrExpr>();
    const expr = (e: IrExpr): void => {
      switch (e.kind) {
        case "assignExpr":
          this.store(sources(e.value), this.localSlot(fn, e.localId));
          break;
        case "call":
          args(e.callee, e.args, 0, e.loc);
          break;
        case "new":
          args(`%${e.className}.constructor`, e.args, 1, e.loc);
          break;
        case "virtualCall":
          for (const impl of this.methodImpls.get(e.method) ?? []) args(impl, e.args, 0, e.loc);
          if (!this.methodImpls.has(e.method))
            for (const a of e.args) escape(a, e.loc, `the method '${e.method}'`);
          break;
        case "arrayLit": {
          const node = sources(e)[0];
          const spreads = new Set(e.spreads ?? []);
          e.elems.forEach((x, i) => {
            if (spreads.has(i)) {
              // Spread elements copy into the literal.
              if (node !== undefined) this.copy(sources(x), [node]);
              if (e.type.kind === "array" && this.direct(e.type.elem))
                this.store(elementSlot(x), `e:${typeKey(e.type)}`);
            } else if (isNumberArray(e.type) && node !== undefined)
              this.writes.push({ fn, target: [node], value: x, arrayText: "", literal: true });
            else if (e.type.kind === "array" && this.holds(x.type))
              this.store(sources(x), `e:${typeKey(e.type)}`);
          });
          break;
        }
        case "arrIntrinsic": {
          const r = e.receiver;
          if (isNumberArray(r.type)) {
            const positions = ELEMENT_ARGS.get(e.method);
            if (positions !== undefined)
              e.args.forEach((a, i) => {
                if (a.type.kind === "f64" && (positions === "all" || positions === i))
                  write(e.method === "with" ? e : r, a);
              });
            // Elements copied in from array arguments (push(...src),
            // splice items).
            if (COPY_IN.has(e.method))
              for (const a of e.args) if (isNumberArray(a.type)) this.copy(sources(a), sources(r));
          } else if (r.type.kind === "array" && this.holds(r.type.elem)) {
            const slot = `e:${typeKey(r.type)}`;
            for (const a of e.args) {
              if (this.direct(a.type)) this.store(sources(a), slot);
              else if (a.type.kind === "array" && typeKey(a.type) !== typeKey(r.type))
                escape(a, e.loc, `Array.${e.method}`);
            }
          } else for (const a of e.args) escape(a, e.loc, `Array.${e.method}`);
          break;
        }
        case "mapIntrinsic":
          if (e.method === "set") {
            const t = typeKey(e.receiver.type);
            if (e.args[0]) this.store(sources(e.args[0]), `mk:${t}`);
            if (e.args[1]) this.store(sources(e.args[1]), `mv:${t}`);
          } else
            for (const a of e.args)
              if (e.method !== "get" && e.method !== "has" && e.method !== "delete")
                escape(a, e.loc, `Map.${e.method}`);
          break;
        case "setIntrinsic":
          if (e.method === "add" && e.args[0])
            this.store(sources(e.args[0]), `se:${typeKey(e.receiver.type)}`);
          break;
        case "mapNew":
          for (const p of e.seed ?? []) {
            this.store(sources(p.key), `mk:${typeKey(e.type)}`);
            this.store(sources(p.value), `mv:${typeKey(e.type)}`);
          }
          break;
        case "setNew":
          if (e.seed && e.seed.type.kind === "array")
            this.store(elementSlot(e.seed), `se:${typeKey(e.type)}`);
          break;
        case "recordLit":
          if (e.type.kind === "record") {
            const shape = this.records.get(e.type.shapeId);
            for (const f of e.fields) {
              const declared = shape?.fields.some((d) => d.name === f.name) === true;
              this.store(sources(f.value), `s:${e.type.shapeId}\0${declared ? f.name : "*"}`);
            }
          } else for (const f of e.fields) escape(f.value, e.loc, "an object literal");
          break;
        case "recordClone":
          if (e.type.kind === "record" && e.source.type.kind === "record") {
            const from = e.source.type.shapeId;
            const shape = this.records.get(e.type.shapeId);
            for (const f of shape?.fields ?? [])
              if (this.direct(f.type))
                this.edge(`s:${from}\0${f.name}`, `s:${e.type.shapeId}\0${f.name}`);
            for (const o of e.overrides)
              this.store(sources(o.value), `s:${e.type.shapeId}\0${o.name}`);
          }
          break;
        case "closure": {
          const lifted = c.functions.get(e.fnName);
          e.captures.forEach((id, i) => {
            const inner = lifted?.captures?.[i];
            if (!inner || !lifted) return;
            const outer = this.localSlot(fn, id);
            const innerSlot = this.localSlot(lifted, inner.localId);
            this.edge(outer, innerSlot);
            this.edge(innerSlot, outer);
          });
          break;
        }
        case "classRef":
          if (e.captures)
            for (const method of c.mod.functions) {
              if (!method.name.startsWith(`%${e.className}.`)) continue;
              for (const cc of method.classCaptures ?? []) {
                const id = e.captures[cc.slot];
                if (id === undefined) continue;
                const outer = this.localSlot(fn, id);
                const inner = this.localSlot(method, cc.localId);
                this.edge(outer, inner);
                this.edge(inner, outer);
              }
            }
          break;
        case "libCall":
          if (!READ_ONLY_LIB.test(e.fn))
            for (const a of e.args) escape(a, a.loc, `the library call ${e.fn}`);
          else for (const a of e.args) if (a.kind === "dynFrom") readOnlyViews.add(a);
          break;
        case "callValue":
          for (const a of e.args) escape(a, a.loc, "a call through a function value");
          if (e.receiver) escape(e.receiver, e.receiver.loc, "a call through a function value");
          break;
        case "dynFrom":
          // Plain arrays and records cross into dynamic code as deep copies;
          // class instances and live references stay connected.
          if (
            !readOnlyViews.has(e) &&
            (e.liveRef === true || this.containsObject(e.value.type, new Set()))
          )
            escape(e.value, e.loc, "dynamic (any or unknown) code");
          break;
        default:
          if (PASS_THROUGH.has(e.kind) || OBSERVE.has(e.kind)) break;
          everyExprChild(
            e,
            (child) => {
              escape(child, child.loc, describe(e));
              return true;
            },
            () => true,
          );
      }
      everyExprChild(
        e,
        (child) => {
          expr(child);
          return true;
        },
        (child) => {
          stmt(child);
          return true;
        },
      );
    };

    const stmt = (s: IrStmt): void => {
      switch (s.kind) {
        case "varDecl":
          if (s.init) this.store(sources(s.init), this.localSlot(fn, s.localId));
          break;
        case "assign":
          this.store(sources(s.value), this.localSlot(fn, s.localId));
          break;
        case "return":
          if (s.value) {
            if (fn.async === true || fn.generator !== undefined)
              escape(s.value, s.loc, "the result of an async function or generator");
            else this.store(sources(s.value), `r:${fn.name}`);
          }
          break;
        case "fieldSet": {
          const family = this.slots.family(s.className, s.field);
          if (family !== null) this.store(sources(s.value), `f:${family}`);
          else escape(s.value, s.loc, "a field scriptc cannot follow");
          break;
        }
        case "recordSet":
          this.store(sources(s.value), `s:${s.shapeId}\0${s.field}`);
          break;
        case "recordKeySet": {
          const t = s.obj.type;
          if (t.kind === "record") {
            const shape = this.records.get(t.shapeId);
            const src = sources(s.value);
            this.store(src, `s:${t.shapeId}\0*`);
            for (const f of shape?.fields ?? [])
              if (this.direct(f.type)) this.store(src, `s:${t.shapeId}\0${f.name}`);
          } else escape(s.value, s.loc, "a dynamically keyed property");
          break;
        }
        case "arraySet":
          if (isNumberArray(s.arr.type)) write(s.arr, s.value);
          else if (s.arr.type.kind === "array" && this.holds(s.arr.type.elem))
            this.store(sources(s.value), `e:${typeKey(s.arr.type)}`);
          break;
        case "forOf":
          if (this.holds(fn.locals.find((l) => l.id === s.localId)?.type ?? s.iterable.type)) {
            const slot = this.localSlot(fn, s.localId);
            const t = s.iterable.type;
            if (t.kind === "array") this.store(elementSlot(s.iterable), slot);
            else {
              // Another iterable yields stored values or unknown ones.
              this.store(this.contained(t), slot);
              for (const node of this.opaqueValue(
                fn.locals.find((l) => l.id === s.localId)?.type ?? t,
                s.loc,
                "an iterator",
              ))
                this.edge(node, slot);
            }
          }
          break;
        case "tryCatch":
          if (s.catchLocalId !== null) {
            const type = fn.locals.find((l) => l.id === s.catchLocalId)?.type;
            if (type && this.holds(type))
              for (const node of this.opaqueValue(type, s.loc, "a caught value"))
                this.edge(node, this.localSlot(fn, s.catchLocalId));
          }
          break;
        case "throw":
          escape(s.value, s.loc, "a throw");
          break;
        default:
          break;
      }
      everyStmtChild(
        s,
        (child) => {
          expr(child);
          return true;
        },
        (child) => {
          stmt(child);
          return true;
        },
      );
    };
    for (const s of fn.body) stmt(s);
  }

  /** Whether a value of type `t` can reach a class instance. */
  private containsObject(t: IrType, seen: Set<string>): boolean {
    const key = typeKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    switch (t.kind) {
      case "object":
        return true;
      case "array":
      case "set":
        return this.containsObject(t.elem, seen);
      case "map":
        return this.containsObject(t.key, seen) || this.containsObject(t.value, seen);
      case "union":
        return (this.unions.get(t.unionId) ?? []).some((a) => this.containsObject(a, seen));
      case "record": {
        const shape = this.records.get(t.shapeId);
        return (
          (shape?.fields.some((f) => this.containsObject(f.type, seen)) ?? false) ||
          (shape?.indexValue !== undefined && this.containsObject(shape.indexValue, seen))
        );
      }
      default:
        return false;
    }
  }

  /* ── solving ── */

  private solve(): void {
    const c = this.c;
    // Backward from every annotated slot: the allocations and origins whose
    // arrays can end up in it are constrained. Forward from those: the
    // nodes that may hold a constrained array. An array whose elements are
    // copied into one that may be constrained must be constrained as well,
    // which can constrain more arrays: repeat until nothing changes.
    const constrained = new Map<string, ContractNote>();
    const expanded = new Set<string>();
    const roots: [string, ContractNote][] = [...this.annotated];
    const forward: string[] = [];
    while (roots.length > 0) {
      for (const [root, note] of roots.splice(0)) {
        if (expanded.has(root)) continue;
        expanded.add(root);
        const queue = [root];
        while (queue.length) {
          const node = queue.pop()!;
          if (this.allocs.has(node) && !constrained.has(node)) {
            constrained.set(node, note);
            if (!this.constrainedReach.has(node)) {
              this.constrainedReach.set(node, note);
              forward.push(node);
            }
          }
          const origin = this.opaque.get(node);
          if (origin)
            c.report(
              "SC7003",
              note.loc,
              `the Int32[] contract on '${note.name}' cannot be checked: the array can come from ${origin.why} (${c.where(origin.loc)}), whose element stores scriptc does not see`,
              "build the array in typed code (a literal, `new Array(n).fill(0)` or `push`) and pass it along, or remove Int32[]",
            );
          for (const p of this.pred.get(node) ?? NO_NODES)
            if (!expanded.has(p)) {
              expanded.add(p);
              queue.push(p);
            }
        }
      }
      while (forward.length) {
        const node = forward.pop()!;
        const note = this.constrainedReach.get(node)!;
        for (const next of this.succ.get(node) ?? NO_NODES)
          if (!this.constrainedReach.has(next)) {
            this.constrainedReach.set(next, note);
            forward.push(next);
          }
      }
      for (const copy of this.copies) {
        const note = this.reachingNote(copy.to);
        if (note === undefined) continue;
        for (const from of copy.from) if (!expanded.has(from)) roots.push([from, note]);
      }
    }
    const queue: string[] = [];
    for (const node of [...this.allocs, ...this.opaque.keys()])
      if (!constrained.has(node)) {
        this.unconstrainedReach.add(node);
        queue.push(node);
      }
    while (queue.length) {
      const node = queue.pop()!;
      for (const next of this.succ.get(node) ?? NO_NODES)
        if (!this.unconstrainedReach.has(next)) {
          this.unconstrainedReach.add(next);
          queue.push(next);
        }
    }
    for (const e of this.escapes) {
      const note = this.reachingNote(e.nodes);
      if (note === undefined) continue;
      c.report(
        "SC7003",
        e.loc,
        `an array that can reach '${note.name}' (Int32[]) escapes to ${e.what}, where its element stores are not checked${e.shown ? `: '${e.shown}'` : ""}`,
        "keep Int32[] arrays in typed code, or pass a copy (`[...xs]`) that no Int32[] slot holds",
      );
    }
    for (const slot of new Set([...this.annotated.keys(), ...this.constrainedReach.keys()]))
      if (!this.unconstrainedReach.has(slot) && /^[lgfrs]:/.test(slot)) this.int32Slots.add(slot);
  }

  private reachingNote(nodes: readonly string[]): ContractNote | undefined {
    for (const n of nodes) {
      const note = this.constrainedReach.get(n);
      if (note) return note;
    }
    return undefined;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function orZero(text: string): string {
  return /^[\w.$]+(\[[^\]]*\])?$/.test(text) ? `${text} | 0` : `(${text}) | 0`;
}

function describe(e: IrExpr): string {
  switch (e.kind) {
    case "dynFrom":
    case "dynObjLit":
    case "dynArrLit":
    case "dynCheck":
      return "dynamic (any or unknown) code";
    case "intrinsic":
      return `the runtime (${e.name})`;
    case "libCall":
      return `the library call ${e.fn}`;
    case "awaitExpr":
      return "an awaited promise";
    default:
      return `an operation scriptc does not follow (${e.kind})`;
  }
}
