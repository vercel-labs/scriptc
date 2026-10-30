import type { IrBytesIntrinsicMethod, IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/* Loop versions over the UTF-16 units of a string that is not ASCII.
 *
 * The runtime publishes the receiver of an indexed scan with its UTF-16
 * units (ScrStrScan, string-reads.ts), and drops them when the string is
 * released or appended to in place, or when its index entry is evicted:
 * the runtime indexes another non-ASCII string. A loop version's string
 * receiver is a binding the loop does not write, which keeps it alive and
 * unappended for the whole loop. Its fast copy over units therefore only
 * needs a body that indexes no other string: the operations below, and
 * calls of functions made of the same operations without string reads
 * (`unitSafeFunctions`). */

const ARRAY_METHODS = new Set(["push", "pop", "length"]);

/* The typed-array and Buffer methods a units copy may run: those that
 * call no program code and read no checked-dynamic value or string. A
 * comparator sort (sortCompare) calls back into the program, and a copy
 * from a checked-dynamic source (setFromDyn) reads its elements through
 * getters; either can index another string, which evicts the receiver's
 * units while the loop reads them. */
const UNIT_SAFE_BYTES_METHODS: ReadonlySet<IrBytesIntrinsicMethod> = new Set([
  "buffer",
  "length",
  "byteLength",
  "byteOffset",
  "get",
  "slice",
  "subarray",
  "copyWithin",
  "sortNumeric",
  "toReversed",
  "with",
  "toArray",
  "setFrom",
  "readNum",
  "writeNum",
  "readNumVar",
  "writeNumVar",
  "equals",
  "compareBuf",
  "indexOfNum",
  "lastIndexOfNum",
  "includesNum",
  "indexOfElem",
  "lastIndexOfElem",
  "includesElem",
  "fill",
  "fillNum",
  "fillElem",
  "copy",
  "swap16",
  "swap32",
  "swap64",
  "dataViewNew",
  "dvGetUint8",
  "dvGetInt8",
  "dvGetUint16",
  "dvGetInt16",
  "dvGetUint32",
  "dvGetInt32",
  "dvGetFloat16",
  "dvGetFloat32",
  "dvGetFloat64",
  "dvGetBigUint64Number",
  "dvGetBigInt64Number",
  "dvSetUint8",
  "dvSetInt8",
  "dvSetUint16",
  "dvSetInt16",
  "dvSetUint32",
  "dvSetInt32",
  "dvSetFloat16",
  "dvSetFloat32",
  "dvSetFloat64",
]);

/** Whether `e` (or statement `s`) uses only operations that index no
 * string: numbers, booleans, locals, records and class fields, typed
 * arrays, number arrays and Math. `reads` admits the string reads a
 * version covers; `calls` the callees. */
function unitSafe(
  node: { e: IrExpr } | { s: IrStmt },
  reads: (e: IrExpr & { kind: "strIntrinsic" }) => boolean,
  calls: (callee: string) => boolean,
): boolean {
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
      case "numLit":
      case "boolLit":
      case "bin":
      case "unary":
      case "logical":
      case "ternary":
      case "toBool":
      case "seqExpr":
      case "assignExpr":
      case "incDec":
      case "recordGet":
      case "fieldGet":
        break;
      case "bytesIntrinsic":
        if (!UNIT_SAFE_BYTES_METHODS.has(e.method)) return false;
        break;
      case "arrayGet":
        if (e.type.kind !== "f64" && e.type.kind !== "bool") return false;
        break;
      case "arrIntrinsic": {
        // Growing or shrinking an array of numbers allocates; it reads no
        // string.
        const array = e.receiver.type;
        if (
          !ARRAY_METHODS.has(e.method) ||
          array.kind !== "array" ||
          (array.elem.kind !== "f64" && array.elem.kind !== "bool")
        )
          return false;
        break;
      }
      case "libCall":
        if (!e.fn.startsWith("math.")) return false;
        break;
      case "call":
        if (!calls(e.callee)) return false;
        break;
      case "strIntrinsic":
        if (!reads(e)) return false;
        break;
      default:
        return false;
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "varDecl":
      case "assign":
      case "exprStmt":
      case "if":
      case "block":
      case "while":
      case "doWhile":
      case "for":
      case "break":
      case "continue":
      case "return":
      case "recordSet":
      case "fieldSet":
      case "bytesSet":
        break;
      default:
        return false;
    }
    return everyStmtChild(s, expr, stmt);
  };
  return "e" in node ? expr(node.e) : stmt(node.s);
}

/** The module's functions a units version may call: synchronous
 * functions without captures whose bodies use only unit-safe operations,
 * read no string, and call only such functions. */
export function unitSafeFunctions(mod: IrModule): ReadonlySet<string> {
  const candidates = new Map(
    mod.functions
      .filter((fn) => !fn.async && !fn.generator && !(fn.captures?.length ?? 0))
      .map((fn) => [fn.name, fn]),
  );
  const safe = new Set(candidates.keys());
  for (let settled = false; !settled;) {
    settled = true;
    for (const name of safe) {
      const fn = candidates.get(name)!;
      const ok = fn.body.every((s) =>
        unitSafe(
          { s },
          () => false,
          (callee) => safe.has(callee),
        ),
      );
      if (!ok) {
        safe.delete(name);
        settled = false;
      }
    }
  }
  return safe;
}

/** The `length` reads of the binding `receiver` in a loop whose every
 * part is unit-safe, reading only charCodeAt and length of `receiver` and
 * calling only `safe` functions; null for any other loop. */
export function unitSafeLoop(
  loop: IrStmt & { kind: "for" | "while" },
  receiver: string,
  safe: ReadonlySet<string>,
): ReadonlySet<IrExpr> | null {
  const lengths = new Set<IrExpr>();
  const reads = (e: IrExpr & { kind: "strIntrinsic" }): boolean => {
    if (e.receiver.kind !== "varRef" || e.receiver.localId !== receiver) return false;
    if (e.method === "length") lengths.add(e);
    return e.method === "charCodeAt" || e.method === "length";
  };
  const calls = (callee: string): boolean => safe.has(callee);
  return unitSafe({ s: loop }, reads, calls) ? lengths : null;
}
