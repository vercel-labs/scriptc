import { InternalCompilerError } from "../../errors.js";
import {
  isClassOwnEnumerableFieldName,
  isDynTypedRefType,
  typeKey,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { toPrimitiveHint } from "./class-dynamic-dispatch.js";
import { GENERATOR_STEP_METHODS, HELPER_METHODS } from "./generator-dynamic-dispatch.js";

/** Runtime entry points that step a checked-dynamic iterable's iterator:
 * destructuring rest, the collection constructors' and Object.fromEntries'
 * seeds, and Math.min/Math.max over a spread. */
const RUNTIME_STEP_LIB_FNS: ReadonlySet<string> = new Set([
  "dyn.destructureRest",
  "dyn.mathFold",
  "dyn.nativeSetNew",
  "dyn.mapSeedEntries",
  "dyn.fromEntries",
  "weakMap.new",
  "weakSet.new",
]);

/** What one function's body holds for the class dispatch pass and its
 * caught-value, generator and class construction sub-passes, collected in
 * one walk. Lists keep the order the walk meets their entries. */
export interface FunctionSites {
  statements: IrStmt[];
  length: number;
  first: IrStmt | undefined;
  last: IrStmt | undefined;
  /** The value types of `dynFrom` expressions, once per type key. */
  values: IrType[];
  /** The types the class dispatch scan boxes, once per type key and class:
   * `dynFrom` values, the parameter types of dynamic functions checked into
   * native function types, and the receivers of own enumerable field writes
   * and updates. A receiver counts only while its class (`fieldClass`)
   * tracks its own fields. */
  boxing: { type: IrType; fieldClass?: string }[];
  /** JSON serialization of dynamic values. */
  serializes: boolean;
  /** ToPrimitive conversions, and `dyn.valueOf` and `dyn.toString` calls. */
  conversions: boolean;
  /** Sites the class dispatch rewrite can change. */
  dispatches: boolean;
  /** `dynHasKey` tests. */
  keyTests: boolean;
  /** `instanceof` tests of caught values, and caught values narrowed or
   * checked to class types. */
  caughtClassTests: boolean;
  /** Calls and reads of generator steps, and reads of iterator helper
   * methods. */
  generatorSteps: boolean;
  /** Values the runtime steps: iterator helper calls and reads, `dynIterN`,
   * and rest destructuring. */
  runtimeSteps: boolean;
  /** `dyn.classBasePrototype` calls. */
  basePrototypes: boolean;
  /** The classes of thrown class instances, once each. */
  thrown: string[];
  /** `caughtToDyn` conversions. */
  caughtValues: boolean;
}

/** The `libCall`s the class dispatch rewrite can change. */
const DISPATCH_LIB_CALLS = new Set<string>([
  "bytes.construct",
  "dyn.keySet",
  "dyn.keySetComputed",
  "dyn.iterator",
  "dyn.arrayFromIterator",
  "dyn.asyncIteratorOpen",
  "dyn.toString",
  "dyn.stringConstructor",
  "dyn.forInKeys",
  "dyn.forInKeyStrings",
  "dyn.hasKeyComputed",
  "dyn.hasOwnComputed",
  "dyn.propertyIsEnumerableComputed",
  "dyn.defineProperty",
  "dyn.getPrototype",
  "dyn.getPrototypeForIdentity",
  "dyn.inheritsErrorPrototype",
  "dyn.reflectGet",
  "dyn.reflectSet",
]);

/** Prototype data helpers (classPrototypeData) gain method slots inside
 * their initialization block, so their summaries are not reused. */
const PROTOTYPE_DATA_PREFIX = "%prototype.data.";

/** SCRIPTC_CHECK_DISPATCH_SCANS=1 checks each reused summary against a fresh walk. */
const CHECK_SCANS = process.env["SCRIPTC_CHECK_DISPATCH_SCANS"] === "1";

/** The function summaries (FunctionSites) of one class dispatch pass, kept
 * across its runs. */
export class DispatchSites {
  private readonly sites = new Map<IrFunction, FunctionSites>();

  /** The sites of `fn`. A summary is reused while the function's statement
   * list is the same array with the same length and the same first and last
   * statements: the dispatch passes replace the lists they rewrite and add
   * statements to the helpers they extend. Other changes inside an
   * unchanged list are reported with `forget`, except in prototype data
   * helpers, which are scanned on every use. */
  of(fn: IrFunction): FunctionSites {
    const cached = this.sites.get(fn);
    if (
      cached !== undefined &&
      !fn.name.startsWith(PROTOTYPE_DATA_PREFIX) &&
      cached.statements === fn.body &&
      cached.length === fn.body.length &&
      cached.first === fn.body[0] &&
      cached.last === fn.body[fn.body.length - 1]
    ) {
      if (CHECK_SCANS && !sameSites(cached, scanSites(fn.body)))
        throw new InternalCompilerError(
          `reused dispatch sites of ${fn.name} disagree with a fresh scan`,
        );
      return cached;
    }
    const sites = scanSites(fn.body);
    this.sites.set(fn, sites);
    return sites;
  }

  /** Drops the summary of a function whose body changed inside an unchanged
   * statement list. */
  forget(fn: IrFunction): void {
    this.sites.delete(fn);
  }
}

function scanSites(statements: IrStmt[]): FunctionSites {
  const sites: FunctionSites = {
    statements,
    length: statements.length,
    first: statements[0],
    last: statements[statements.length - 1],
    values: [],
    boxing: [],
    serializes: false,
    conversions: false,
    dispatches: false,
    keyTests: false,
    caughtClassTests: false,
    generatorSteps: false,
    runtimeSteps: false,
    basePrototypes: false,
    thrown: [],
    caughtValues: false,
  };
  const valueKeys = new Set<string>();
  const boxingKeys = new Set<string>();
  const thrown = new Set<string>();
  const box = (type: IrType, fieldClass?: string): void => {
    const key = `${fieldClass ?? ""}\0${typeKey(type)}`;
    if (boxingKeys.has(key)) return;
    boxingKeys.add(key);
    sites.boxing.push(fieldClass === undefined ? { type } : { type, fieldClass });
  };
  everyStmtList(statements, {
    stmt: (statement) => {
      if (statement.kind === "throw" && statement.value.type.kind === "object") {
        const className = statement.value.type.className;
        if (!thrown.has(className)) {
          thrown.add(className);
          sites.thrown.push(className);
        }
      }
      // Field-creation instrumentation can box a base-constructor receiver
      // even when only its derived instances otherwise cross the boundary.
      if (statement.kind === "fieldSet" && isClassOwnEnumerableFieldName(statement.field))
        box(statement.obj.type, statement.className);
      return true;
    },
    expr: (expr) => {
      if (
        expr.kind === "jsonStringify" ||
        (expr.kind === "libCall" &&
          (expr.fn === "json.stringifyValue" || expr.fn === "json.stringifyReplacer"))
      )
        sites.serializes = true;
      if (
        toPrimitiveHint(expr) !== null ||
        (expr.kind === "libCall" && (expr.fn === "dyn.valueOf" || expr.fn === "dyn.toString"))
      )
        sites.conversions = true;
      if (
        (expr.kind === "dynInvoke" && GENERATOR_STEP_METHODS.has(expr.method)) ||
        (expr.kind === "dynKeyGet" &&
          expr.key.kind === "strLit" &&
          (GENERATOR_STEP_METHODS.has(expr.key.value) || HELPER_METHODS.has(expr.key.value)))
      )
        sites.generatorSteps = true;
      if (
        (expr.kind === "dynInvoke" && HELPER_METHODS.has(expr.method)) ||
        (expr.kind === "dynKeyGet" &&
          expr.key.kind === "strLit" &&
          HELPER_METHODS.has(expr.key.value)) ||
        expr.kind === "dynIterN" ||
        (expr.kind === "libCall" && RUNTIME_STEP_LIB_FNS.has(expr.fn))
      )
        sites.runtimeSteps = true;
      switch (expr.kind) {
        case "dynFrom": {
          const key = typeKey(expr.value.type);
          if (!valueKeys.has(key)) {
            valueKeys.add(key);
            sites.values.push(expr.value.type);
          }
          box(expr.value.type);
          break;
        }
        case "fieldIncDec":
          if (isClassOwnEnumerableFieldName(expr.field)) box(expr.obj.type, expr.className);
          break;
        case "call":
          if (
            (expr.callee === "%dyn.class.properties" ||
              expr.callee === "%dyn.class.readProperties") &&
            expr.args[0]?.kind === "dynFrom" &&
            isDynTypedRefType(expr.args[0].value.type)
          )
            sites.dispatches = true;
          break;
        case "dynHasKey":
          sites.keyTests = true;
          break;
        case "caughtTest":
          if (expr.test === "instanceof") sites.caughtClassTests = true;
          break;
        case "caughtNarrow":
        case "caughtCheck":
          if (expr.type.kind === "object") sites.caughtClassTests = true;
          break;
        case "caughtToDyn":
          sites.caughtValues = true;
          break;
        case "dynKeyGet":
        case "dynInvoke":
          sites.dispatches = true;
          break;
        case "dynCheck":
          if (isDynTypedRefType(expr.type)) sites.dispatches = true;
          // A dynamic function checked into a native function type
          // receives its arguments as dynamic values: class instances
          // passed to it cross the boundary when it is called (a JS
          // `list.map((rec) => rec.match(x))` callback with an untyped
          // parameter).
          if (expr.type.kind === "func") expr.type.params.forEach((type) => box(type));
          break;
        case "libCall":
          if (expr.fn === "dyn.classBasePrototype") sites.basePrototypes = true;
          if (DISPATCH_LIB_CALLS.has(expr.fn)) sites.dispatches = true;
          break;
      }
      return true;
    },
  });
  return sites;
}

function sameSites(left: FunctionSites, right: FunctionSites): boolean {
  const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean =>
    a.length === b.length && a.every((item, index) => same(item, b[index]!));
  return (
    sameList(left.values, right.values, (a, b) => a === b) &&
    sameList(
      left.boxing,
      right.boxing,
      (a, b) => a.type === b.type && a.fieldClass === b.fieldClass,
    ) &&
    sameList(left.thrown, right.thrown, (a, b) => a === b) &&
    left.serializes === right.serializes &&
    left.conversions === right.conversions &&
    left.dispatches === right.dispatches &&
    left.keyTests === right.keyTests &&
    left.caughtClassTests === right.caughtClassTests &&
    left.generatorSteps === right.generatorSteps &&
    left.runtimeSteps === right.runtimeSteps &&
    left.basePrototypes === right.basePrototypes &&
    left.caughtValues === right.caughtValues
  );
}
