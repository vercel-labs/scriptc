/* Contract types (@scriptc/types), the IR side. The frontend collects the
 * written annotations (frontend/contract-types.ts) keyed by the source
 * locations the lowering stamps on IR functions, bindings and classes; this
 * pass binds them to IR names and checks each contract against every write
 * in the whole program:
 *
 * - NoThrow<T>: the function is outside the may-throw fixpoint
 *   (backend/may-throw.ts, where handlers discharge what they catch), or
 *   the diagnostic names the throwing path.
 * - Int32: every value stored into the slot is an int32 by construction,
 *   proven by the same integer range analysis the int32 storage uses,
 *   assuming every Int32 slot holds an int32 (sound by induction: every
 *   write is checked under that assumption).
 * - Int32[]: every element stored into an array that can reach the slot is
 *   an int32 (contracts/int32-elements.ts), so present element reads
 *   through slots only such arrays reach are int32s.
 * - Acyclic: the class or object type cannot lie on a reference cycle, by
 *   the cycle analysis that decides tracing (backend/cycle-analysis.ts), or
 *   the diagnostic shows the cycle.
 * - Immutable<T>: no mutation can reach a value that may come from an
 *   Immutable slot, values stored into Immutable slots are fresh (nothing
 *   else references them), and such values never escape to code the IR
 *   cannot see. Module constants built from fresh literals become immortal.
 * - ProgramLifetime (class marker): the class is a hierarchy root in an
 *   executable; its hierarchy is then never freed and takes no reference
 *   counts (classes.ts programLifetimeClass).
 *
 * Verified facts land on the IR as `contracts` (IrContracts). */
import type { DiagnosticCode } from "../diagnostics/codes.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type {
  IrClassDef,
  IrContracts,
  IrExpr,
  IrFunction,
  IrModule,
  IrStmt,
  IrType,
  SrcLoc,
} from "../ir/ir.js";
import { isRefCounted, typeKey } from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";
import {
  analyzeIntegerRanges,
  INT32_RANGE,
  integerArithmeticRange,
  withinInt32,
  type IntegerRange,
  type IntegerRanges,
  type IntegerSlotFacts,
} from "../ir/integer-ranges.js";
import { findInitializerBindings, withInitializerBindings } from "../ir/initializer-bindings.js";
import { unshareNodes } from "../ir/unshare.js";
import { dynamicallyStoredFamilies, functionCallFacts, Int32Slots } from "../ir/int32-slots.js";
import { computeMayThrow, type MayThrowReason } from "../backend/may-throw.js";
import {
  computeTraced,
  explainCycle,
  type CycleEdgeLabel,
  type CycleExplanation,
  type CycleStep,
} from "../backend/cycle-analysis.js";
import { SourceLocations } from "../backend/source-locations.js";
import { Int32ElementContracts } from "./int32-elements.js";
import {
  contractLocKey,
  type ContractAnnotations,
  type ContractNote,
} from "../frontend/contract-types.js";

/** The largest array index: 2^32 - 2 (ECMA-262 array index). */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

export interface ContractCheckResult {
  diagnostics: ScrDiagnostic[];
  contracts: IrContracts | null;
}

/** Walk every expression and statement of a function body, parents first. */
function walk(
  body: readonly IrStmt[],
  visit: { expr?: (e: IrExpr) => void; stmt?: (s: IrStmt) => void },
): void {
  const expr = (e: IrExpr): boolean => {
    visit.expr?.(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    visit.stmt?.(s);
    return everyStmtChild(s, expr, stmt);
  };
  for (const s of body) stmt(s);
}

function baseName(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return slash >= 0 ? file.slice(slash + 1) : file;
}

export function checkContracts(
  mod: IrModule,
  annotations: ContractAnnotations,
  sourceTexts: ReadonlyMap<string, string>,
): ContractCheckResult {
  // Range proofs are keyed by node identity: check the module emission sees.
  const checker = new ContractChecker(unshareNodes(mod), annotations, sourceTexts);
  return checker.run();
}

class ContractChecker {
  readonly diagnostics: ScrDiagnostic[] = [];
  private readonly reported = new Set<string>();
  private readonly positions: SourceLocations;
  readonly functions = new Map<string, IrFunction>();
  readonly classes = new Map<string, IrClassDef>();
  private readonly fnByLoc = new Map<string, IrFunction[]>();
  private readonly localsByLoc = new Map<string, { fn: IrFunction; localId: string }[]>();
  private readonly globalsByLoc = new Map<string, string[]>();
  private readonly classesByLoc = new Map<string, IrClassDef[]>();
  private readonly contracts: IrContracts = {};
  /** Whether any verified fact was recorded. */
  private recorded = false;

  constructor(
    readonly mod: IrModule,
    readonly notes: ContractAnnotations,
    readonly sources: ReadonlyMap<string, string>,
  ) {
    this.positions = new SourceLocations(sources);
    for (const fn of mod.functions) {
      this.functions.set(fn.name, fn);
      // Synthetic dynamic-class helpers (%dyn.*) carry the location of the
      // code that first needed them, which is not their declaration.
      if (!fn.name.startsWith("%dyn.")) push(this.fnByLoc, contractLocKey(fn.loc), fn);
      for (const local of fn.locals)
        if (local.source)
          push(this.localsByLoc, contractLocKey(local.source.loc), { fn, localId: local.id });
    }
    for (const g of mod.globals ?? [])
      if (g.source) push(this.globalsByLoc, contractLocKey(g.source.loc), g.id);
    for (const cls of mod.classes ?? []) {
      this.classes.set(cls.name, cls);
      push(this.classesByLoc, contractLocKey(cls.loc), cls);
    }
  }

  /* ── reporting ── */

  where(loc: SrcLoc | null): string {
    if (loc === null) return "?";
    const pos = this.positions.position(loc);
    return pos ? `${baseName(pos.file)}:${pos.line}:${pos.column}` : baseName(loc.file);
  }

  text(loc: SrcLoc, max = 60): string {
    const source = this.sources.get(loc.file);
    if (source === undefined || loc.end <= loc.start) return "";
    const raw = source.slice(loc.start, loc.end).replace(/\s+/g, " ").trim();
    return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw;
  }

  report(code: DiagnosticCode, loc: SrcLoc, message: string, hint: string): void {
    const key = `${code}\0${contractLocKey(loc)}\0${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diagnostics.push({ code, loc, message, hint });
  }

  displayName(fnName: string): string {
    const fn = this.functions.get(fnName);
    const method = /^%(.*)\.([^.]+)$/.exec(fnName);
    if (method && !fnName.startsWith("%fn") && !fnName.startsWith("%init")) {
      const cls = this.classes.get(method[1]!);
      const owner = cls?.jsName ?? method[1]!;
      return `${owner}.${method[2]}`;
    }
    if (fn?.sourceName !== undefined && fn.sourceName !== "<anonymous>") return fn.sourceName;
    if (fn !== undefined && /^%fn\.[0-9a-f]{12}$/.test(fnName))
      return `the function at ${this.where(fn.loc)}`;
    return fnName.replace(/^%/, "");
  }

  /** A short TypeScript-like spelling of an IR type, for messages. */
  typeText(t: IrType): string {
    switch (t.kind) {
      case "f64":
        return "number";
      case "bool":
        return "boolean";
      case "undefinedT":
        return "undefined";
      case "nullT":
        return "null";
      case "object":
        return this.classes.get(t.className)?.jsName ?? t.className.replace(/^%(m\d+\.)?/, "");
      case "union": {
        const def = this.mod.unions?.find((u) => u.id === t.unionId);
        return def ? def.arms.map((a) => this.typeText(a)).join(" | ") : "a union";
      }
      default:
        return t.kind;
    }
  }

  /** Why a throwing parameter access exists although the source type looks
   * safe: the frontend compiles a parameter as `T | undefined` (or null)
   * when a caller can pass a missing value, typically a non-null asserted
   * element read `xs[i]!`, so the TypeError Node raises inside the callee
   * happens there too. Names the parameter and the first such call. */
  private widenedParams(fnName: string | undefined): string {
    const fn = fnName === undefined ? undefined : this.functions.get(fnName);
    if (fn === undefined) return "";
    const nullable = (t: IrType): boolean =>
      t.kind === "undefinedT" ||
      t.kind === "nullT" ||
      (t.kind === "union" &&
        this.mod.unions
          ?.find((u) => u.id === t.unionId)
          ?.arms.some((a) => a.kind === "undefinedT" || a.kind === "nullT") === true);
    const params = fn.params.filter((p) => nullable(p.type));
    if (params.length === 0) return "";
    const p = params[0]!;
    const index = fn.params.indexOf(p);
    let site: SrcLoc | null = null;
    for (const caller of this.mod.functions) {
      if (site !== null) break;
      walk(caller.body, {
        expr: (e) => {
          if (site !== null || e.kind !== "call" || e.callee !== fn.name) return;
          const arg = e.args[index];
          if (arg !== undefined && nullable(arg.type)) site = arg.loc;
        },
      });
    }
    const name = p.name;
    const because = site !== null ? `: the argument at ${this.where(site)} can be missing` : "";
    return ` (parameter '${name}' is compiled as ${this.typeText(p.type)}${because})`;
  }

  /* ── binding annotations to IR ── */

  bindingsOf(key: string): { fn: IrFunction | null; id: string }[] {
    const locals = (this.localsByLoc.get(key) ?? []).map((l) => ({ fn: l.fn, id: l.localId }));
    const globals = (this.globalsByLoc.get(key) ?? []).map((id) => ({ fn: null, id }));
    return [...locals, ...globals];
  }

  functionsAt(key: string): readonly IrFunction[] {
    return this.fnByLoc.get(key) ?? [];
  }

  classesAt(key: string): readonly IrClassDef[] {
    return this.classesByLoc.get(key) ?? [];
  }

  run(): ContractCheckResult {
    this.checkProgramLifetime();
    this.checkNoThrow();
    this.checkAcyclic();
    const elements = new Int32ElementContracts(this);
    elements.analyze();
    const int32 = new Int32Contracts(this, elements);
    int32.run();
    const immutable = new ImmutableContracts(this);
    immutable.run();
    if (this.diagnostics.length > 0) return { diagnostics: this.diagnostics, contracts: null };
    const c = this.contracts;
    return { diagnostics: [], contracts: this.recorded ? c : null };
  }

  record(field: keyof IrContracts, values: readonly string[]): void {
    const list = [...new Set(values)].sort();
    if (list.length === 0) return;
    this.contracts[field] = list;
    this.recorded = true;
  }

  /* ── ProgramLifetime ── */

  /** `class C implements ProgramLifetime`: a memory-only promise, so no
   * program behavior depends on it except that instances are never freed.
   * Checked: the class is the root of its hierarchy (every subclass, and so
   * every value of any static type in the hierarchy, is then program-
   * lifetime, which is what lets the backend elide reference counting on
   * those static types); and the build is an executable (library hosts own
   * the lifetimes of the objects they receive). Publication to other
   * threads needs no check: an instance carries a reference count of its
   * own until publication marks it like any other object it reaches
   * (classes.ts programLifetimeRc). Static code has no WeakRef, and a
   * FinalizationRegistry never runs its cleanup callbacks; weak collections
   * stay correct because an entry keyed by an object that is never freed is
   * never observable as removed. */
  private checkProgramLifetime(): void {
    if (this.notes.classes.size === 0) return;
    const roots: string[] = [];
    for (const [key, note] of this.notes.classes)
      for (const cls of this.classesAt(key)) {
        if (cls.base !== undefined) {
          const base = this.classes.get(cls.base);
          const baseName = base?.jsName ?? cls.base.replace(/^%(m\d+\.)?/, "");
          this.report(
            "SC7008",
            note.loc,
            `'${note.name}' is declared ProgramLifetime but extends '${baseName}'`,
            base === undefined || base.runtime === true
              ? "ProgramLifetime applies to classes the program owns end to end; built-in bases (errors, emitters, streams) keep runtime state that is released with the object"
              : `declare ProgramLifetime on the root class '${baseName}' instead; it applies to every subclass`,
          );
          continue;
        }
        if (this.mod.lib !== undefined) {
          this.report(
            "SC7008",
            note.loc,
            `'${note.name}' is declared ProgramLifetime in a library build`,
            "a library's host decides when the objects it receives are released; ProgramLifetime is checked in executables only",
          );
          continue;
        }
        roots.push(cls.name);
      }
    if (roots.length === 0) return;
    this.record("programLifetime", roots);
  }

  /* ── Acyclic ── */

  private checkAcyclic(): void {
    if (this.notes.acyclic.length === 0) return;
    const traced = computeTraced(this.mod);
    const proven: string[] = [];
    // Object types are structural in the IR: name a record by the
    // interface or alias that declared it Acyclic.
    for (const { note, unit } of this.notes.acyclic)
      if (unit != null && unit.startsWith("record:")) this.unitNames.set(unit, note.name);
    for (const { note, classKey, unit } of this.notes.acyclic) {
      // A class may lower to several IR classes (generic instantiations);
      // an unused type has no unit and no values, so it holds trivially.
      const units =
        classKey !== undefined
          ? this.classesAt(classKey).map((cls) => `object:${cls.name}`)
          : unit != null
            ? [unit]
            : [];
      for (const key of units) {
        const isTraced = key.startsWith("union:")
          ? traced.unions.has(key.slice("union:".length))
          : traced.shapes.has(key);
        if (!isTraced) {
          proven.push(key);
          continue;
        }
        const why = explainCycle(this.mod, key);
        this.report(
          "SC7007",
          note.loc,
          `'${note.name}' is declared Acyclic but can lie on a reference cycle: ${why ? this.cycleText(key, why) : "the cycle analysis traces it"}`,
          why ? this.cycleHint(why) : "remove Acyclic",
        );
        break;
      }
    }
    this.record("acyclic", proven);
  }

  private readonly unitNames = new Map<string, string>();

  /** A unit key's spelling: a class name, a record's declared name or
   * `{ a, b }`, the arms of a union. */
  unitText(key: string): string {
    const named = this.unitNames.get(key);
    if (named !== undefined) return named;
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon),
      id = key.slice(colon + 1);
    if (kind === "object" || kind === "subtree")
      return this.typeText({ kind: "object", className: id });
    if (kind === "union") return this.typeText({ kind: "union", unionId: id });
    const record = this.mod.records?.find((r) => r.id === id);
    return record ? `{ ${record.fields.map((f) => f.name).join(", ")} }` : "an object";
  }

  private fieldText(field: string): string {
    if (field === "%dynProperties") return "(dynamic properties)";
    if (field === "<listeners>") return "(event listeners)";
    if (field === "<class>") return "(class object)";
    if (field === "<overflow>") return "[key]";
    return field;
  }

  /** The path as `A.f → B.g → A`, folding union and subclass hops into the
   * field that reaches them. */
  private stepsText(steps: readonly CycleStep[], end: string): string {
    const parts: string[] = [];
    // A slot of class type C holding a subclass D reads `D (as a C)`.
    let asBase: string | null = null;
    const unit = (key: string): string => {
      const text = this.unitText(key);
      const suffix = asBase !== null && asBase !== text ? ` (as a ${asBase})` : "";
      asBase = null;
      return `${text}${suffix}`;
    };
    for (const step of steps) {
      if (step.label.kind === "subclass") {
        asBase ??= this.unitText(step.from);
        continue;
      }
      if (step.label.kind === "field")
        parts.push(`${unit(step.from)}.${this.fieldText(step.label.field)}`);
    }
    parts.push(unit(end));
    return parts.join(" → ");
  }

  private cycleText(key: string, why: CycleExplanation): string {
    switch (why.kind) {
      case "hierarchy":
        return `its subclass '${this.unitText(why.member)}' shares its object layout, and ${this.cycleText(why.member, why.because)}`;
      case "intrinsic": {
        const holds =
          why.holds === "func"
            ? "a function"
            : why.holds === "dyn"
              ? "a dynamic value"
              : why.holds === "caught"
                ? "a caught exception"
                : why.holds === "promise"
                  ? "a promise"
                  : "a class object";
        const field =
          why.field === "%dynProperties"
            ? `${this.unitText(why.owner)} instances reach dynamic code, whose properties`
            : why.field === ""
              ? this.unitText(why.owner)
              : `${this.unitText(why.owner)}.${this.fieldText(why.field)}`;
        const path = why.steps.length > 0 ? `${this.stepsText(why.steps, why.owner)}, and ` : "";
        return `${path}${field} can hold ${holds}, which can reference any object, including a ${this.unitText(key)}`;
      }
      case "cycle": {
        const mutable = why.steps.find(
          (s): s is CycleStep & { label: CycleEdgeLabel & { kind: "field" } } =>
            s.label.kind === "field" && (s.label.mutable || s.label.via !== undefined),
        );
        let reason = "";
        if (mutable) {
          const where = `${this.unitText(mutable.from)}.${this.fieldText(mutable.label.field)}`;
          if (mutable.label.via !== undefined)
            reason = ` (${where} is ${mutable.label.via === "array" ? "an array" : `a ${mutable.label.via === "map" ? "Map" : "Set"}`}, whose contents can change)`;
          else {
            const write = this.writeOutsideConstructor(mutable.from, mutable.label.field);
            reason = ` (${where} can be assigned after construction${write !== null ? `, as at ${this.where(write)}` : ""})`;
          }
        }
        return `${this.stepsText(why.steps, key)}${reason}`;
      }
    }
  }

  private cycleHint(why: CycleExplanation): string {
    const inner = why.kind === "hierarchy" ? why.because : why;
    if (inner.kind === "intrinsic")
      return "a function, dynamic or promise field can capture the object itself; store plain data instead, or remove Acyclic";
    if (
      inner.kind === "cycle" &&
      !inner.steps.some(
        (s) => s.label.kind === "field" && s.label.mutable && s.label.via === undefined,
      )
    )
      return "an array, Map or Set can come to hold an object that refers back; make the element type unable to reach this type, or remove Acyclic";
    return "assign the reference only in the constructor (before `this` escapes), so a new object can only point to older ones, or remove Acyclic";
  }

  /** The first store into the field outside its own class's constructors. */
  private writeOutsideConstructor(unit: string, field: string): SrcLoc | null {
    const colon = unit.indexOf(":");
    const kind = unit.slice(0, colon),
      id = unit.slice(colon + 1);
    let found: SrcLoc | null = null;
    for (const fn of this.mod.functions) {
      if (found !== null) break;
      const ctor = /^%(.*)\.constructor$/.exec(fn.name)?.[1];
      const self = ctor !== undefined ? fn.params[0]?.localId : undefined;
      walk(fn.body, {
        stmt: (s) => {
          if (found !== null) return;
          if (kind === "record" && s.kind === "recordSet" && s.shapeId === id && s.field === field)
            found = s.loc;
          else if (
            kind !== "record" &&
            s.kind === "fieldSet" &&
            s.field === field &&
            this.sameHierarchy(s.className, id) &&
            !(self !== undefined && s.obj.kind === "varRef" && s.obj.localId === self)
          )
            found = s.loc;
        },
      });
    }
    return found;
  }

  private sameHierarchy(a: string, b: string): boolean {
    const root = (name: string): string => {
      let cur = name;
      for (let cls = this.classes.get(cur); cls?.base !== undefined; cls = this.classes.get(cur))
        cur = cls.base;
      return cur;
    };
    return root(a) === root(b);
  }

  /* ── NoThrow ── */

  private checkNoThrow(): void {
    const targets: { fn: IrFunction; note: ContractNote }[] = [];
    for (const [key, list] of this.notes.functions)
      for (const note of list)
        if (note.marker === "NoThrow")
          for (const fn of this.fnByLoc.get(key) ?? []) targets.push({ fn, note });
    if (targets.length === 0) return;
    // Target-independent: the native stack guard (Linux, macOS) counts, so a
    // contract holds on every platform. Every function on a call cycle counts
    // as checking it, a superset of the functions the backend picks, so the
    // answer does not depend on that choice.
    const mt = computeMayThrow(this.mod, { stackChecks: "everyCycleMember", explain: true });
    const proven: string[] = [];
    for (const { fn, note } of targets) {
      if (fn.async === true || fn.generator !== undefined) {
        this.report(
          "SC7001",
          note.loc,
          `'${note.name}' is declared NoThrow, but async functions and generators report errors through promises and resumption, which the contract does not cover`,
          "remove NoThrow from async functions and generators",
        );
        continue;
      }
      if (!mt.fns.has(fn.name)) {
        proven.push(fn.name);
        continue;
      }
      const steps: string[] = [];
      // The function's own stack guard throws on entry, outside any handler.
      const ownStackGuard = mt.stackChecks?.has(fn.name) === true;
      const seen = new Set<string>();
      let current: string | undefined = fn.name;
      while (current !== undefined && !seen.has(current) && steps.length < 8) {
        seen.add(current);
        const reason: MayThrowReason | undefined = mt.why?.get(current);
        if (reason === undefined) break;
        if (reason.kind === "seed") {
          steps.push(`${reason.what} at ${this.where(reason.loc)}${this.widenedParams(current)}`);
          current = undefined;
        } else if (reason.kind === "call") {
          steps.push(`calls '${this.displayName(reason.callee)}' at ${this.where(reason.loc)}`);
          current = reason.callee;
        } else {
          steps.push(
            reason.target === ""
              ? `calls a function value at ${this.where(reason.loc)} (dynamic callbacks may throw)`
              : `calls a function value at ${this.where(reason.loc)}, and the function value '${this.displayName(reason.target)}' may throw`,
          );
          current = reason.target === "" ? undefined : reason.target;
        }
      }
      this.report(
        "SC7001",
        note.loc,
        `'${note.name}' is declared NoThrow but may throw: ${steps.join(" → ")}`,
        ownStackGuard
          ? "remove the recursion or remove NoThrow; a recursive function's stack guard throws on entry, outside any try/catch"
          : this.mod.workers === true
            ? "remove the throwing operation from the path (or the recursion), or remove NoThrow; in worker programs try/catch does not discharge the contract, since a termination request unwinds through catch"
            : "remove the throwing operation from the path (or the recursion), catch it with try/catch, or remove NoThrow",
      );
    }
    this.record("noThrow", proven);
  }
}

/** The explicit int32 form of a written expression: `x++` and compound
 * assignments become an assignment of the `| 0` result. */
function int32Rewrite(text: string): string {
  const step = /^(.+?)\s*(\+\+|--)$/.exec(text) ?? /^(\+\+|--)\s*(.+)$/.exec(text);
  if (step) {
    const target = step[1] === "++" || step[1] === "--" ? step[2]! : step[1]!;
    const op = (step[1] === "++" || step[1] === "--" ? step[1] : step[2]!)[0]!;
    return `${target} = (${target} ${op} 1) | 0`;
  }
  const compound = /^([^=]+?)\s*(\*\*|>>>|<<|>>|[-+*/%&|^])=\s*(.+)$/.exec(text);
  if (compound) return `${compound[1]} = (${compound[1]} ${compound[2]} ${compound[3]}) | 0`;
  const assignment = /^([^=]+?)\s*=\s*([^=].*)$/.exec(text);
  if (assignment) return `${assignment[1]} = ${orZero(assignment[2]!)}`;
  return orZero(text);
}

/** `text | 0`, parenthesized unless `text` binds tighter than `|` for sure
 * (a name, member chain, literal or call without nested parentheses). */
function orZero(text: string): string {
  return /^[\w$.]+(\([^()]*\))?$/.test(text) ? `${text} | 0` : `(${text}) | 0`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/* ─────────────────────────────── Int32 ─────────────────────────────── */

class Int32Contracts {
  private readonly slots: Int32Slots;
  /** Field families, with the note that declared them. */
  private readonly fields = new Map<string, ContractNote>();
  private readonly params = new Map<string, ContractNote>(); // fn\0localId
  private readonly returns = new Map<string, ContractNote>(); // fn
  private readonly locals = new Map<string, ContractNote>(); // fn\0localId or \0globalId

  constructor(
    private readonly c: ContractChecker,
    private readonly elements: Int32ElementContracts,
  ) {
    this.slots = new Int32Slots(c.classes);
  }

  run(): void {
    if (!this.bind()) return;
    const scalars = this.fields.size + this.params.size + this.returns.size + this.locals.size;
    if (scalars === 0 && !this.elements.active) return;
    this.structural();
    this.writes();
    this.c.record("int32Fields", [...this.fields.keys()]);
    this.c.record("int32Params", [...this.params.keys()]);
    this.c.record("int32Returns", [...this.returns.keys()]);
    this.c.record("int32Locals", [...this.locals.keys()]);
    this.c.record("int32Elements", [...this.elements.int32Slots]);
  }

  private refuse(note: ContractNote, why: string, hint: string): void {
    this.c.report(
      "SC7003",
      note.loc,
      `the Int32 contract on '${note.name}' cannot be checked: ${why}`,
      hint,
    );
  }

  private bind(): boolean {
    const c = this.c;
    for (const [key, list] of c.notes.functions)
      for (const note of list) {
        if (note.marker !== "Int32" || note.elements === true) continue;
        for (const fn of c.functionsAt(key)) {
          if (fn.async === true || fn.generator !== undefined) {
            this.refuse(
              note,
              "async functions and generators return promises or iterators",
              "annotate the awaited value where it is stored instead",
            );
            continue;
          }
          if (fn.returnType.kind !== "f64") {
            this.refuse(
              note,
              "the result is not a plain number",
              "write Int32 only on a number result",
            );
            continue;
          }
          this.returns.set(fn.name, note);
        }
      }
    for (const [key, note] of c.notes.bindings) {
      if (note.marker !== "Int32" || note.elements === true) continue;
      for (const b of c.bindingsOf(key)) {
        const type = b.fn
          ? b.fn.locals.find((l) => l.id === b.id)?.type
          : c.mod.globals?.find((g) => g.id === b.id)?.type;
        if (type?.kind !== "f64") {
          this.refuse(
            note,
            "the binding is not a plain number (optional and union types are not int32 slots)",
            "declare it as a required Int32",
          );
          continue;
        }
        if (b.fn === null) {
          this.locals.set(`\0${b.id}`, note);
          continue;
        }
        this.locals.set(`${b.fn.name}\0${b.id}`, note);
        if (b.fn.params.some((p) => p.localId === b.id))
          this.params.set(`${b.fn.name}\0${b.id}`, note);
      }
    }
    for (const [key, note] of c.notes.fields) {
      if (note.marker !== "Int32" || note.elements === true) continue;
      const cut = key.lastIndexOf("\0");
      const field = key.slice(cut + 1);
      for (const cls of c.classesAt(key.slice(0, cut))) {
        const def = cls.fields.find((f) => f.name === field);
        if (!def) {
          this.refuse(
            note,
            `the compiled class has no field '${field}'`,
            "annotate an ordinary instance field",
          );
          continue;
        }
        if (def.type.kind !== "f64") {
          this.refuse(
            note,
            "the field is not a plain number",
            "declare the field as a required Int32",
          );
          continue;
        }
        const family = this.slots.family(cls.name, field);
        if (family !== null) this.fields.set(family, note);
      }
    }
    // Captured bindings: every capture of an Int32 local shares its box.
    this.propagateCaptures();
    return true;
  }

  private propagateCaptures(): void {
    const c = this.c;
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of c.mod.functions)
        walk(fn.body, {
          expr: (e) => {
            if (e.kind !== "closure") return;
            const lifted = c.functions.get(e.fnName);
            e.captures.forEach((id, i) => {
              const inner = lifted?.captures?.[i];
              if (!inner) return;
              const outerKey = `${fn.name}\0${id}`;
              const innerKey = `${lifted!.name}\0${inner.localId}`;
              const outer = this.locals.get(outerKey);
              const innerNote = this.locals.get(innerKey);
              if (outer && !innerNote) {
                this.locals.set(innerKey, outer);
                changed = true;
              } else if (innerNote && !outer) {
                this.locals.set(outerKey, innerNote);
                changed = true;
              }
            });
          },
        });
    }
  }

  /** Slots whose writes the IR does not show. */
  private structural(): void {
    const c = this.c;
    const mod = c.mod;
    if (this.fields.size > 0) {
      const dynamic = dynamicallyStoredFamilies(mod, this.slots);
      for (const [family, note] of this.fields) {
        const owner = family.slice(0, family.indexOf("\0"));
        let generic = false;
        for (
          let cls = c.classes.get(owner);
          cls;
          cls = cls.base ? c.classes.get(cls.base) : undefined
        )
          if (
            cls.runtime === true ||
            cls.genericOf !== undefined ||
            (cls.base && !c.classes.has(cls.base))
          )
            generic = true;
        for (const cls of c.classes.values())
          if (cls.genericOf !== undefined && (cls.genericOf === owner || cls.name === owner))
            generic = true;
        if (generic)
          this.refuse(
            note,
            "the class is generic or extends a runtime-provided class",
            "move the field to a non-generic class",
          );
        else if (dynamic.has(family))
          this.refuse(
            note,
            "instances of the class reach dynamic code (any or unknown casts) where a store to the field is not checked",
            "keep instances of this class out of any-typed values, or remove Int32",
          );
      }
    }
    if (this.params.size > 0) {
      const children = new Map<string, string[]>();
      for (const cls of c.classes.values()) if (cls.base) push(children, cls.base, cls.name);
      const subtree = (name: string): string[] => {
        const out: string[] = [];
        const stack = [name];
        while (stack.length) {
          const next = stack.pop()!;
          out.push(next);
          for (const child of children.get(next) ?? []) stack.push(child);
        }
        return out;
      };
      const calls = functionCallFacts(mod, c.classes, subtree);
      for (const [key, note] of this.params) {
        const fnName = key.slice(0, key.indexOf("\0"));
        if (calls.valueEscaped.has(fnName))
          this.refuse(
            note,
            `'${c.displayName(fnName)}' is used as a value (callback, class value or export), so its callers are not all visible`,
            "wrap it in a function that takes a number and passes `x | 0`",
          );
        else if (calls.runtimeVirtual(fnName))
          this.refuse(
            note,
            "the runtime calls this method",
            "remove Int32 from runtime-dispatched methods",
          );
      }
    }
  }

  private int32Facts(fnName: string): IntegerSlotFacts {
    const params = new Map<string, IntegerRange>();
    for (const key of this.params.keys())
      if (key.startsWith(`${fnName}\0`)) params.set(key.slice(fnName.length + 1), INT32_RANGE);
    return {
      params,
      field: (className, field) => {
        const family = this.slots.family(className, field);
        return family !== null && this.fields.has(family) ? INT32_RANGE : null;
      },
      call: (callee) => (this.returns.has(callee) ? INT32_RANGE : null),
      boxed: (localId) => (this.locals.has(`${fnName}\0${localId}`) ? INT32_RANGE : null),
      locals: (localId) =>
        this.locals.has(`${fnName}\0${localId}`) || this.locals.has(`\0${localId}`)
          ? INT32_RANGE
          : null,
      elements: (arr) => this.elements.readsInt32(fnName, arr),
    };
  }

  private writes(): void {
    const c = this.c;
    const methodImpls = new Map<string, string[]>();
    for (const cls of c.classes.values())
      for (const m of cls.methods ?? []) push(methodImpls, m, `%${cls.name}.${m}`);
    const bindings = findInitializerBindings(c.mod);
    const fail = (note: ContractNote, value: IrExpr | null, at: SrcLoc, what: string): void => {
      const shown = value ? c.text(value.loc) : "";
      c.report(
        "SC7002",
        at,
        `${what} '${note.name}' (Int32) is not provably an int32${shown ? `: '${shown}'` : ""}`,
        shown
          ? `make the int32 conversion explicit, for example '${int32Rewrite(shown)}', so Node computes the same value`
          : "make the int32 conversion explicit with '| 0', so Node computes the same value",
      );
    };
    const elementFunctions = this.elements.functionsWithWrites();
    const elementRanges = new Map<string, IntegerRanges>();
    for (const fn of c.mod.functions) {
      const numeric = withInitializerBindings(fn, bindings.get(fn.name) ?? []);
      const ranges = analyzeIntegerRanges(numeric, this.int32Facts(fn.name));
      if (elementFunctions.has(fn.name)) elementRanges.set(fn.name, ranges);
      // Scalar Int32 slots accept exactly what the backend's int32 storage
      // proves (int32-slots.ts stores pinned slots from proven writes).
      const int32 = (e: IrExpr): boolean => e.type.kind === "f64" && withinInt32(ranges.get(e));
      const localNote = (id: string): ContractNote | undefined =>
        this.locals.get(`${fn.name}\0${id}`) ?? this.locals.get(`\0${id}`);
      const checkArgs = (callee: string, args: IrExpr[], offset: number, at: SrcLoc): void => {
        const target = c.functions.get(callee);
        if (!target) return;
        target.params.forEach((param, i) => {
          const note = this.params.get(`${callee}\0${param.localId}`);
          if (!note) return;
          const arg = args[i - offset];
          if (i < offset) return;
          if (arg === undefined) fail(note, null, at, "a call passes no argument for");
          else if (!int32(arg)) fail(note, arg, arg.loc, "the argument for");
        });
      };
      const incDecStored = (e: IrExpr, prefix: boolean, op: "+" | "-"): boolean => {
        const result = ranges.get(e);
        if (!result) return false;
        if (prefix) return withinInt32(result);
        return withinInt32(integerArithmeticRange(op, result, { min: 1, max: 1 }));
      };
      walk(fn.body, {
        stmt: (s) => {
          if (s.kind === "varDecl" || s.kind === "assign") {
            const note = localNote(s.localId);
            const value = s.kind === "varDecl" ? s.init : s.value;
            if (note && value && !int32(value))
              fail(note, value, value.loc, "the value stored into");
          } else if (s.kind === "forOf" || (s.kind === "tryCatch" && s.catchLocalId !== null)) {
            const id = s.kind === "forOf" ? s.localId : s.catchLocalId!;
            const note = localNote(id);
            if (note)
              fail(
                note,
                null,
                s.loc,
                s.kind === "forOf"
                  ? "a for-of loop element stored into"
                  : "a caught value stored into",
              );
          } else if (s.kind === "fieldSet") {
            const family = this.slots.family(s.className, s.field);
            const note = family !== null ? this.fields.get(family) : undefined;
            if (note && !int32(s.value)) fail(note, s.value, s.value.loc, "the value stored into");
          } else if (s.kind === "return") {
            const note = this.returns.get(fn.name);
            if (note && (!s.value || !int32(s.value)))
              fail(note, s.value, s.value?.loc ?? s.loc, "the value returned from");
          }
        },
        expr: (e) => {
          if (e.kind === "assignExpr") {
            const note = localNote(e.localId);
            if (note && !int32(e.value)) fail(note, e.value, e.value.loc, "the value stored into");
          } else if (e.kind === "incDec") {
            const note = localNote(e.localId);
            if (note && !incDecStored(e, e.prefix, e.op))
              c.report(
                "SC7002",
                e.loc,
                `'${c.text(e.loc)}' can step '${note.name}' (Int32) outside the int32 range`,
                `bound the value by an Int32 comparison in the loop condition, or write '${note.name} = (${note.name} ${e.op} 1) | 0'`,
              );
          } else if (e.kind === "fieldIncDec") {
            const family = this.slots.family(e.className, e.field);
            const note = family !== null ? this.fields.get(family) : undefined;
            if (note) {
              const target = c.text(e.obj.loc);
              const field = `${target}.${e.field}`;
              c.report(
                "SC7002",
                e.loc,
                `'${c.text(e.loc)}' can step the Int32 field '${note.name}' outside the int32 range`,
                `write '${field} = (${field} ${e.op} 1) | 0'`,
              );
            }
          } else if (e.kind === "call") checkArgs(e.callee, e.args, 0, e.loc);
          else if (e.kind === "new") checkArgs(`%${e.className}.constructor`, e.args, 1, e.loc);
          else if (e.kind === "virtualCall")
            for (const impl of methodImpls.get(e.method) ?? []) checkArgs(impl, e.args, 0, e.loc);
        },
      });
    }
    this.elements.checkWrites((fn, value) => {
      const proven = (e: IrExpr): boolean =>
        e.type.kind === "f64" && withinInt32(elementRanges.get(fn.name)?.get(e));
      return proven(value) || this.elements.provenElement(fn, value, proven);
    });
  }
}

/* ───────────────────────────── Immutable ───────────────────────────── */

/** Read-only and searching array intrinsics: the receiver is not written,
 * and arguments are compared or copied out, never stored. */
const ARR_READS = new Set([
  "length",
  "getNumber",
  "indexEq",
  "indexOf",
  "includes",
  "nextPresent",
  "join",
  "slice",
  "flatCopy",
  "flatOne",
  "toReversed",
  "toSpliced",
  "toSortedPrimitive",
  "concatSpread",
]);
const MAP_READS = new Set([
  "get",
  "has",
  "size",
  "iterCount",
  "iterStart",
  "iterLive",
  "iterKey",
  "iterValue",
  "iterEnter",
  "iterExit",
  "clone",
  "keySet",
  "valueSet",
]);
const SET_READS = new Set([
  "has",
  "size",
  "iterCount",
  "iterStart",
  "iterLive",
  "iterKey",
  "iterEnter",
  "iterExit",
  "clone",
]);
/** Element reads whose result can be part of the receiver's graph. */
const MAP_ELEMENT_READS = new Set(["get", "iterKey", "iterValue"]);
const SET_ELEMENT_READS = new Set(["iterKey"]);
/** Copies: a fresh container holding the receiver's elements. */
const ARR_COPIES = new Set([
  "slice",
  "flatCopy",
  "flatOne",
  "toReversed",
  "toSpliced",
  "concatSpread",
  "toSortedPrimitive",
]);
const COLLECTION_COPIES = new Set(["clone", "keySet", "valueSet"]);
/** Expression kinds whose result is the same value as their child. */
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
/** Observations: the value is inspected, never stored or written. */
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
]);
/** Library calls that only read their arguments (console output). */
const LIB_READS = /^(console\.|inspect\.|json\.stringify)/;

class ImmutableContracts {
  /** Annotated slots: storing into them requires a fresh or immutable value. */
  private readonly annotated = new Map<string, ContractNote>();
  /** Slots that may hold an immutable value (annotated plus inferred). */
  private readonly mayHold = new Set<string>();
  /** The first store that made an inferred slot hold an immutable value. */
  private readonly via = new Map<string, string>();
  /** Functions whose results are fresh (factory functions). */
  private readonly freshFns = new Set<string>();
  private readonly methodImpls = new Map<string, string[]>();
  private readonly slots: Int32Slots;
  /** freshLocalsOf results, valid once the factory set is final. */
  private readonly freshLocalsCache = new Map<string, Set<string>>();
  private factoriesFinal = false;

  constructor(private readonly c: ContractChecker) {
    this.slots = new Int32Slots(c.classes);
    for (const cls of c.classes.values())
      for (const m of cls.methods ?? []) push(this.methodImpls, m, `%${cls.name}.${m}`);
  }

  private refuse(note: ContractNote, why: string, hint: string): void {
    this.c.report(
      "SC7005",
      note.loc,
      `the Immutable contract on '${note.name}' cannot be checked: ${why}`,
      hint,
    );
  }

  run(): void {
    this.bind();
    if (this.annotated.size === 0) return;
    for (const key of this.annotated.keys()) this.mayHold.add(key);
    this.computeFreshFunctions();
    // Grow the may-hold set to a fixpoint, then report from the final pass.
    for (let round = 0; round < 64; round++) {
      const before = this.mayHold.size;
      this.pass(false);
      if (this.mayHold.size === before) break;
    }
    this.pass(true);
    this.immortalGlobals();
  }

  private bind(): void {
    const c = this.c;
    for (const [key, note] of c.notes.bindings) {
      if (note.marker !== "Immutable") continue;
      for (const b of c.bindingsOf(key))
        this.annotated.set(b.fn ? `l:${b.fn.name}\0${b.id}` : `g:${b.id}`, note);
    }
    for (const [key, list] of c.notes.functions)
      for (const note of list)
        if (note.marker === "Immutable")
          for (const fn of c.functionsAt(key)) this.annotated.set(`r:${fn.name}`, note);
    for (const [key, note] of c.notes.fields) {
      if (note.marker !== "Immutable") continue;
      const cut = key.lastIndexOf("\0");
      const field = key.slice(cut + 1);
      for (const cls of c.classesAt(key.slice(0, cut))) {
        const family = this.slots.family(cls.name, field);
        if (family === null)
          this.refuse(
            note,
            `the compiled class has no field '${field}'`,
            "annotate an ordinary instance field",
          );
        else this.annotated.set(`f:${family}`, note);
      }
    }
  }

  private localSlot(fn: IrFunction, id: string): string {
    return id.startsWith("%g.") ? `g:${id}` : `l:${fn.name}\0${id}`;
  }
  private fieldSlot(className: string, field: string): string | null {
    const family = this.slots.family(className, field);
    return family === null ? null : `f:${family}`;
  }

  /** A factory: every return is fresh, built from literals and locals that
   * only it references. */
  private computeFreshFunctions(): void {
    const c = this.c;
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of c.mod.functions) {
        if (this.freshFns.has(fn.name) || fn.async || fn.generator || fn.captures?.length) continue;
        if (!isRefCounted(fn.returnType) || fn.returnType.kind === "string") continue;
        const freshLocals = this.freshLocalsOf(fn);
        let returns = 0;
        let ok = true;
        walk(fn.body, {
          stmt: (s) => {
            if (s.kind !== "return") return;
            returns++;
            if (!s.value || !this.fresh(s.value, freshLocals)) ok = false;
          },
        });
        if (ok && returns > 0) {
          this.freshFns.add(fn.name);
          changed = true;
        }
      }
    }
    this.factoriesFinal = true;
  }

  /** Locals of `fn` that only ever hold fresh values and are used only as
   * intrinsic receivers, field-write targets, element writes and returns:
   * the value leaves the function only by `return`. */
  private freshLocalsOf(fn: IrFunction): Set<string> {
    const cached = this.factoriesFinal ? this.freshLocalsCache.get(fn.name) : undefined;
    if (cached !== undefined) return cached;
    const result = this.computeFreshLocals(fn);
    if (this.factoriesFinal) this.freshLocalsCache.set(fn.name, result);
    return result;
  }

  private computeFreshLocals(fn: IrFunction): Set<string> {
    const candidates = new Set(
      fn.locals.filter((l) => !l.boxed && isRefCounted(l.type)).map((l) => l.id),
    );
    for (const p of fn.params) candidates.delete(p.localId);
    const allowed = new Set<IrExpr>();
    let ranges: IntegerRanges | undefined;
    // An element write at a negative, fractional or too-large index adds an
    // ordinary property instead, and publication refuses arrays that carry
    // properties: only writes at provable array indexes keep a value fresh.
    // Typed-array writes never add properties.
    const arrayIndex = (index: IrExpr): boolean => {
      ranges ??= analyzeIntegerRanges(fn);
      const range = ranges.get(index);
      return (
        range !== null && range !== undefined && range.min >= 0 && range.max <= MAX_ARRAY_INDEX
      );
    };
    walk(fn.body, {
      stmt: (s) => {
        if (s.kind === "return" && s.value?.kind === "varRef") allowed.add(s.value);
        if ((s.kind === "fieldSet" || s.kind === "recordSet") && s.obj.kind === "varRef")
          allowed.add(s.obj);
        if (s.kind === "bytesSet" && s.arr.kind === "varRef") allowed.add(s.arr);
        if (s.kind === "arraySet" && s.arr.kind === "varRef" && arrayIndex(s.index))
          allowed.add(s.arr);
      },
      expr: (e) => {
        if (
          (e.kind === "arrIntrinsic" || e.kind === "mapIntrinsic" || e.kind === "setIntrinsic") &&
          e.receiver.kind === "varRef"
        )
          allowed.add(e.receiver);
        if ((e.kind === "arrayGet" || e.kind === "arrayHas") && e.arr.kind === "varRef")
          allowed.add(e.arr);
        if ((e.kind === "fieldGet" || e.kind === "recordGet") && e.obj.kind === "varRef")
          allowed.add(e.obj);
      },
    });
    for (let changed = true; changed;) {
      changed = false;
      walk(fn.body, {
        stmt: (s) => {
          const value = s.kind === "varDecl" ? s.init : s.kind === "assign" ? s.value : undefined;
          const target = s.kind === "varDecl" || s.kind === "assign" ? s.localId : "";
          if (value && candidates.has(target) && !this.fresh(value, candidates)) {
            candidates.delete(target);
            changed = true;
          }
          if (s.kind === "forOf" && candidates.delete(s.localId)) changed = true;
        },
        expr: (e) => {
          if (e.kind === "varRef" && candidates.has(e.localId) && !allowed.has(e)) {
            candidates.delete(e.localId);
            changed = true;
          }
          if ((e.kind === "assignExpr" || e.kind === "incDec") && candidates.delete(e.localId))
            changed = true;
        },
      });
    }
    return candidates;
  }

  /** A value nothing else references: a literal, a fresh construction or
   * factory result, a primitive, or a value that is already immutable. */
  private fresh(
    e: IrExpr,
    freshLocals: ReadonlySet<string>,
    derived?: (e: IrExpr) => boolean,
  ): boolean {
    if (!isRefCounted(e.type) || e.type.kind === "string") return true;
    if (derived?.(e)) return true;
    switch (e.kind) {
      case "strLit":
      case "unitLit":
        return true;
      case "varRef":
        return freshLocals.has(e.localId);
      case "arrayLit":
        return e.elems.every((x) => this.fresh(x, freshLocals, derived));
      case "recordLit":
        return e.fields.every((f) => this.fresh(f.value, freshLocals, derived));
      case "mapNew":
        return (e.seed ?? []).every(
          (p) =>
            this.fresh(p.key, freshLocals, derived) && this.fresh(p.value, freshLocals, derived),
        );
      case "setNew":
        return e.seed === undefined || this.fresh(e.seed, freshLocals, derived);
      case "new":
        return (
          this.constructorKeepsThis(e.className) &&
          e.args.every((a) => this.fresh(a, freshLocals, derived))
        );
      case "call":
        return (
          this.freshFns.has(e.callee) && e.args.every((a) => this.fresh(a, freshLocals, derived))
        );
      case "upcast":
      case "downcast":
      case "unionWrap":
      case "unionRetype":
      case "unionNarrow":
        return this.fresh(e.value, freshLocals, derived);
      case "ternary":
        return (
          this.fresh(e.then, freshLocals, derived) && this.fresh(e.else_, freshLocals, derived)
        );
      default:
        return false;
    }
  }

  /** The constructor chain uses `this` only to read and write its own
   * fields: the new object is referenced from nowhere else. */
  private constructorKeepsThis(className: string): boolean {
    const c = this.c;
    for (
      let cls = c.classes.get(className);
      cls;
      cls = cls.base ? c.classes.get(cls.base) : undefined
    ) {
      if (cls.runtime === true) return false;
      const ctor = c.functions.get(`%${cls.name}.constructor`);
      if (!ctor) continue;
      const self = ctor.params[0]?.localId;
      if (self === undefined) return false;
      const allowed = new Set<IrExpr>();
      walk(ctor.body, {
        stmt: (s) => {
          if (s.kind === "fieldSet" && s.obj.kind === "varRef") allowed.add(s.obj);
        },
        expr: (e) => {
          if (e.kind === "fieldGet" && e.obj.kind === "varRef") allowed.add(e.obj);
          if (
            e.kind === "call" &&
            e.callee === `%${cls.base}.constructor` &&
            e.args[0]?.kind === "varRef"
          )
            allowed.add(e.args[0]);
        },
      });
      let ok = true;
      walk(ctor.body, {
        expr: (e) => {
          if (e.kind === "varRef" && e.localId === self && !allowed.has(e)) ok = false;
          if (e.kind === "closure" && e.captures.includes(self)) ok = false;
        },
      });
      if (!ok) return false;
    }
    return true;
  }

  /** One pass over the program: derived values, stores, escapes and
   * mutations. With `report`, violations become diagnostics. */
  private pass(report: boolean): void {
    const c = this.c;
    for (const fn of c.mod.functions) {
      const derivedMemo = new Map<IrExpr, boolean>();
      const freshLocals = this.freshLocalsOf(fn);
      const derived = (e: IrExpr): boolean => {
        if (!isRefCounted(e.type) || e.type.kind === "string") return false;
        const memo = derivedMemo.get(e);
        if (memo !== undefined) return memo;
        derivedMemo.set(e, false);
        const result = this.derivedExpr(fn, e, derived);
        derivedMemo.set(e, result);
        return result;
      };
      const hold = (slot: string | null, value: IrExpr, at: string): void => {
        if (slot === null || !derived(value)) return;
        if (!this.mayHold.has(slot)) {
          this.mayHold.add(slot);
          this.via.set(slot, at);
        }
      };
      const store = (slot: string | null, value: IrExpr, how?: string): void => {
        if (slot === null) return;
        const note = this.annotated.get(slot);
        if (note && report && !this.fresh(value, freshLocals, derived)) {
          c.report(
            "SC7004",
            value.loc,
            `the value stored into '${note.name}' (Immutable) may be referenced elsewhere: '${c.text(value.loc)}' is not a fresh literal, construction or factory result`,
            "build the value in place (a literal, `new`, or a function that returns what it builds), so no mutable reference to it remains",
          );
        }
        hold(slot, value, how ?? `stored at ${c.where(value.loc)}`);
      };
      const mutate = (target: IrExpr, at: SrcLoc, what: string): void => {
        if (!report || !derived(target)) return;
        const shown = c.text(target.loc);
        const origin = this.originOf(fn, target);
        const subject =
          origin === "" && shown !== "" && shown !== c.text(at) ? ` ('${shown}')` : "";
        c.report(
          "SC7004",
          at,
          `${what} writes to a value that may be Immutable${subject}${origin}`,
          "Immutable values cannot be written through any reference; copy the value before changing it",
        );
      };
      const escape = (value: IrExpr, at: SrcLoc, what: string): void => {
        if (!report || !derived(value)) return;
        c.report(
          "SC7005",
          at,
          `a value that may be Immutable escapes to ${what}, where writes are not checked: '${c.text(value.loc)}'${this.originOf(fn, value)}`,
          "keep Immutable values in typed code, or copy the value before handing it out",
        );
      };
      const args = (callee: string, list: IrExpr[], offset: number, at: SrcLoc): void => {
        const target = c.functions.get(callee);
        list.forEach((arg, i) => {
          const param = target?.params[i + offset];
          if (!target || !param)
            return escape(arg, arg.loc, `a call to '${c.displayName(callee)}'`);
          store(
            `l:${callee}\0${param.localId}`,
            arg,
            `passed to '${c.displayName(callee)}' at ${c.where(at)}`,
          );
        });
      };
      walk(fn.body, {
        stmt: (s) => {
          switch (s.kind) {
            case "varDecl":
              if (s.init) store(this.localSlot(fn, s.localId), s.init);
              break;
            case "assign":
              store(this.localSlot(fn, s.localId), s.value);
              break;
            case "return":
              if (s.value)
                store(
                  `r:${fn.name}`,
                  s.value,
                  `returned from '${c.displayName(fn.name)}' at ${c.where(s.loc)}`,
                );
              break;
            case "fieldSet":
              mutate(s.obj, s.loc, `'${c.text(s.loc)}'`);
              store(this.fieldSlot(s.className, s.field), s.value);
              break;
            case "recordSet":
              mutate(s.obj, s.loc, `'${c.text(s.loc)}'`);
              store(`s:${s.shapeId}\0${s.field}`, s.value);
              break;
            case "recordKeySet":
              mutate(s.obj, s.loc, `'${c.text(s.loc)}'`);
              escape(s.value, s.loc, "a dynamically keyed property");
              break;
            case "recordKeyDelete":
              mutate(s.obj, s.loc, `'${c.text(s.loc)}'`);
              break;
            case "arraySet":
              mutate(s.arr, s.loc, `'${c.text(s.loc)}'`);
              store(`e:${typeKey(s.arr.type)}`, s.value);
              break;
            case "arraySetLength":
            case "arraySetUndefined":
            case "arrayDelete":
            case "bytesSet":
              mutate(s.arr, s.loc, `'${c.text(s.loc)}'`);
              break;
            case "forOf": {
              const slot = this.localSlot(fn, s.localId);
              const elems =
                this.mayHold.has(`e:${typeKey(s.iterable.type)}`) ||
                this.mayHold.has(`se:${typeKey(s.iterable.type)}`);
              if ((elems || derived(s.iterable)) && !this.mayHold.has(slot)) {
                this.mayHold.add(slot);
                this.via.set(slot, `iterated at ${c.where(s.loc)}`);
              }
              break;
            }
            case "throw":
              escape(s.value, s.loc, "a throw");
              break;
          }
        },
        expr: (e) => {
          switch (e.kind) {
            case "assignExpr":
              store(this.localSlot(fn, e.localId), e.value);
              return;
            case "call":
              return args(e.callee, e.args, 0, e.loc);
            case "new":
              return args(`%${e.className}.constructor`, e.args, 1, e.loc);
            case "virtualCall":
              for (const impl of this.methodImpls.get(e.method) ?? []) args(impl, e.args, 0, e.loc);
              return;
            case "fieldIncDec":
              return mutate(e.obj, e.loc, `'${c.text(e.loc)}'`);
            case "arrIntrinsic":
              if (ARR_COPIES.has(e.method))
                this.copyElements(e.receiver, e.type, derived(e.receiver), c.where(e.loc));
              if (!ARR_READS.has(e.method)) mutate(e.receiver, e.loc, `'${c.text(e.loc)}'`);
              for (const a of e.args) {
                if (e.method === "indexOf" || e.method === "includes" || e.method === "indexEq")
                  continue;
                store(`e:${typeKey(e.receiver.type)}`, a);
              }
              return;
            case "mapIntrinsic":
              if (COLLECTION_COPIES.has(e.method))
                this.copyElements(e.receiver, e.type, derived(e.receiver), c.where(e.loc));
              if (!MAP_READS.has(e.method)) mutate(e.receiver, e.loc, `'${c.text(e.loc)}'`);
              if (e.method === "set") {
                if (e.args[0]) store(`mk:${typeKey(e.receiver.type)}`, e.args[0]);
                if (e.args[1]) store(`mv:${typeKey(e.receiver.type)}`, e.args[1]);
              }
              return;
            case "setIntrinsic":
              if (COLLECTION_COPIES.has(e.method))
                this.copyElements(e.receiver, e.type, derived(e.receiver), c.where(e.loc));
              if (!SET_READS.has(e.method)) mutate(e.receiver, e.loc, `'${c.text(e.loc)}'`);
              if (e.method === "add" && e.args[0])
                store(`se:${typeKey(e.receiver.type)}`, e.args[0]);
              return;
            case "arrayLit":
              for (const x of e.elems) store(`e:${typeKey(e.type)}`, x);
              return;
            case "recordLit":
              if (e.type.kind === "record")
                for (const f of e.fields) store(`s:${e.type.shapeId}\0${f.name}`, f.value);
              return;
            case "mapNew":
              for (const p of e.seed ?? []) {
                store(`mk:${typeKey(e.type)}`, p.key);
                store(`mv:${typeKey(e.type)}`, p.value);
              }
              return;
            case "closure": {
              const lifted = c.functions.get(e.fnName);
              e.captures.forEach((id, i) => {
                const inner = lifted?.captures?.[i];
                const outer = this.localSlot(fn, id);
                if (!inner) return;
                const innerSlot = `l:${lifted!.name}\0${inner.localId}`;
                if (this.mayHold.has(outer) && !this.mayHold.has(innerSlot)) {
                  this.mayHold.add(innerSlot);
                  this.via.set(innerSlot, `captured at ${c.where(e.loc)}`);
                }
              });
              return;
            }
            case "libCall":
              if (!LIB_READS.test(e.fn))
                for (const a of e.args) escape(a, a.loc, `the library call ${e.fn}`);
              return;
            case "callValue":
              for (const a of e.args) escape(a, a.loc, "a call through a function value");
              if (e.receiver) escape(e.receiver, e.receiver.loc, "a call through a function value");
              return;
          }
          if (PASS_THROUGH.has(e.kind) || OBSERVE.has(e.kind)) return;
          if (e.kind === "fieldGet" || e.kind === "recordGet" || e.kind === "arrayGet") return;
          // Any other parent: a derived child goes somewhere this pass does
          // not follow (dynamic conversions, runtime helpers).
          everyExprChild(
            e,
            (child) => {
              escape(child, child.loc, describeSink(e));
              return true;
            },
            () => true,
          );
        },
      });
    }
  }

  /** A copy of a container whose elements may be immutable: the copy's
   * element slots may hold them too (the copy itself is fresh). */
  private copyElements(
    receiver: IrExpr,
    result: IrType,
    receiverDerived: boolean,
    where: string,
  ): void {
    const at = `copied at ${where}`;
    const rk = typeKey(receiver.type);
    const sources = [`e:${rk}`, `mk:${rk}`, `mv:${rk}`, `se:${rk}`];
    if (!receiverDerived && !sources.some((slot) => this.mayHold.has(slot))) return;
    const key = typeKey(result);
    for (const slot of [`e:${key}`, `se:${key}`, `mk:${key}`, `mv:${key}`])
      if (!this.mayHold.has(slot)) {
        this.mayHold.add(slot);
        this.via.set(slot, at);
      }
  }

  private originOf(fn: IrFunction, e: IrExpr): string {
    let root = e;
    for (let steps = 0; steps < 16; steps++) {
      if (root.kind === "fieldGet" || root.kind === "recordGet") root = root.obj;
      else if (root.kind === "arrayGet") root = root.arr;
      else if (root.kind === "seqExpr") root = root.result;
      // A receiver that is the element when it is present and otherwise
      // throws (`xs[i]!.push(v)`) is that element read.
      else if (
        root.kind === "ternary" &&
        root.else_.kind === "libCall" &&
        root.else_.fn === "error.nodeThrow"
      )
        root = root.then;
      else if (
        root.kind === "upcast" ||
        root.kind === "downcast" ||
        root.kind === "unionWrap" ||
        root.kind === "unionRetype" ||
        root.kind === "unionNarrow" ||
        root.kind === "assignExpr"
      )
        root = root.value;
      else if (root.kind === "varRef") {
        // Compiler temporaries (no source binding): follow their initializer.
        const id = root.localId;
        const local = fn.locals.find((l) => l.id === id);
        if (local === undefined || local.source !== undefined) break;
        let init: IrExpr | null = null;
        walk(fn.body, {
          stmt: (s) => {
            if (s.kind === "varDecl" && s.localId === id && s.init) init ??= s.init;
          },
        });
        if (init === null) break;
        root = init;
      } else break;
    }
    if (root.kind === "varRef") {
      const slot = this.localSlot(fn, root.localId);
      const note = this.annotated.get(slot);
      if (note) return ` (from '${note.name}')`;
      const via = this.via.get(slot);
      if (via) {
        const local = fn.locals.find((l) => l.id === root.localId);
        return ` ('${local?.name ?? root.localId}' may be an Immutable value ${via})`;
      }
    }
    return "";
  }

  /** Whether `e` may evaluate to (part of) an Immutable value. */
  private derivedExpr(fn: IrFunction, e: IrExpr, derived: (e: IrExpr) => boolean): boolean {
    switch (e.kind) {
      case "varRef":
        return this.mayHold.has(this.localSlot(fn, e.localId));
      case "fieldGet": {
        const slot = this.fieldSlot(e.className, e.field);
        return (slot !== null && this.mayHold.has(slot)) || derived(e.obj);
      }
      case "recordGet":
        return (
          this.mayHold.has(
            `s:${e.obj.type.kind === "record" ? e.obj.type.shapeId : ""}\0${e.field}`,
          ) || derived(e.obj)
        );
      case "arrayGet":
        return this.mayHold.has(`e:${typeKey(e.arr.type)}`) || derived(e.arr);
      case "mapIntrinsic":
        return (
          MAP_ELEMENT_READS.has(e.method) &&
          (this.mayHold.has(`mv:${typeKey(e.receiver.type)}`) ||
            this.mayHold.has(`mk:${typeKey(e.receiver.type)}`) ||
            derived(e.receiver))
        );
      case "setIntrinsic":
        return (
          SET_ELEMENT_READS.has(e.method) &&
          (this.mayHold.has(`se:${typeKey(e.receiver.type)}`) || derived(e.receiver))
        );
      case "call":
        return this.mayHold.has(`r:${e.callee}`);
      case "virtualCall":
        return (this.methodImpls.get(e.method) ?? []).some((impl) => this.mayHold.has(`r:${impl}`));
      case "ternary":
        return derived(e.then) || derived(e.else_);
      case "logical":
      case "nullish":
        return derived(e.left) || derived(e.right);
      case "seqExpr":
        return derived(e.result);
      case "assignExpr":
        return derived(e.value);
      case "upcast":
      case "downcast":
      case "unionWrap":
      case "unionRetype":
      case "unionNarrow":
        return derived(e.value);
      default: {
        if (!PASS_THROUGH.has(e.kind)) return false;
        let any = false;
        everyExprChild(
          e,
          (child) => {
            any ||= derived(child);
            return !any;
          },
          () => true,
        );
        return any;
      }
    }
  }

  /** Module constants with an Immutable annotation, written once from a
   * fresh value of a publishable type: the backend makes them immortal. */
  private immortalGlobals(): void {
    const c = this.c;
    if (c.mod.lib !== undefined || c.diagnostics.length > 0) return;
    const out: string[] = [];
    for (const g of c.mod.globals ?? []) {
      if (
        g.mutable ||
        g.tdz === true ||
        g.initFlag !== undefined ||
        !this.annotated.has(`g:${g.id}`)
      )
        continue;
      if (!this.publishable(g.type, new Set())) continue;
      let writes = 0;
      let fresh = true;
      for (const fn of c.mod.functions) {
        const freshLocals = this.freshLocalsOf(fn);
        walk(fn.body, {
          stmt: (s) => {
            if ((s.kind === "assign" || s.kind === "varDecl") && s.localId === g.id) {
              writes++;
              const value = s.kind === "assign" ? s.value : s.init;
              if (!value || !this.fresh(value, freshLocals)) fresh = false;
            }
          },
          expr: (e) => {
            if (e.kind === "assignExpr" && e.localId === g.id) writes++;
          },
        });
      }
      if (writes === 1 && fresh) out.push(g.id);
    }
    c.record("immortalGlobals", out);
  }

  /** Static types the publication walkers handle without a refusal. */
  private publishable(t: IrType, seen: Set<string>): boolean {
    const c = this.c;
    switch (t.kind) {
      case "f64":
      case "bool":
      case "string":
      case "undefinedT":
      case "nullT":
        return true;
      case "array":
      case "set":
        return this.publishable(t.elem, seen);
      case "map":
        return this.publishable(t.key, seen) && this.publishable(t.value, seen);
      case "record": {
        const key = `r:${t.shapeId}`;
        if (seen.has(key)) return true;
        seen.add(key);
        const shape = c.mod.records?.find((r) => r.id === t.shapeId);
        return (
          !!shape && !shape.indexValue && shape.fields.every((f) => this.publishable(f.type, seen))
        );
      }
      case "union": {
        const key = `u:${t.unionId}`;
        if (seen.has(key)) return true;
        seen.add(key);
        const def = c.mod.unions?.find((u) => u.id === t.unionId);
        return !!def && def.arms.every((arm) => this.publishable(arm, seen));
      }
      case "object": {
        const key = `o:${t.className}`;
        if (seen.has(key)) return true;
        seen.add(key);
        // Subclasses can stand behind a base-typed reference.
        for (const cls of c.classes.values()) {
          let under = false;
          for (
            let x: IrClassDef | undefined = cls;
            x;
            x = x.base ? c.classes.get(x.base) : undefined
          )
            if (x.name === t.className) under = true;
          if (!under) continue;
          for (
            let x: IrClassDef | undefined = cls;
            x;
            x = x.base ? c.classes.get(x.base) : undefined
          )
            if (x.runtime === true || x.localCaptures !== undefined) return false;
          if (!cls.fields.every((f) => f.name.startsWith("%") || this.publishable(f.type, seen)))
            return false;
        }
        return true;
      }
      default:
        return false;
    }
  }
}

function describeSink(e: IrExpr): string {
  switch (e.kind) {
    case "dynFrom":
    case "dynObjLit":
    case "dynArrLit":
      return "dynamic (any or unknown) code";
    case "intrinsic":
      return `the runtime (${e.name})`;
    default:
      return `an operation scriptc does not follow (${e.kind})`;
  }
}
