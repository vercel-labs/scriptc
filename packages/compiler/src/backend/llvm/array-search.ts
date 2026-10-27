/* Inline indexOf / includes over arrays of references.
 *
 * The runtime search (scr_arr_index_of_ref) checks each slot's state byte and
 * dispatches on the element kind for every element. When the array's
 * hole-free prefix covers its whole length (filled == len, so there are no
 * holes and no sparse entries), the internal helpers below scan the dense
 * slots directly, and LLVM inlines them at the call site:
 *
 * - sc_arr_index_of_ptr, for element types whose strict equality and
 *   SameValueZero are both pointer identity (class instances, records,
 *   arrays, maps, sets, typed arrays): 64-bit compares, four slots per
 *   branch.
 * - sc_arr_index_of_cref, the same over the 4-byte slots of compact class
 *   references (SCR_ELEM_CREF), against the needle's 32-bit reference.
 * - sc_arr_index_of_str, for strings: pointer identity, then the length,
 *   then the bytes. Strings of up to 16 bytes compare as two words; a short
 *   string's word is the eight bytes ending at its last byte, which start
 *   in the string header when it is shorter than eight bytes and so stay
 *   inside the object, shifted down past the header bytes. Longer strings
 *   compare with scr_str_eq.
 *
 * Any other array takes the runtime search. Both helpers answer the index,
 * or -1; includes compares the answer with 0, since for these element types
 * SameValueZero and strict equality agree. Every target scriptc builds for
 * is little-endian, which the short-string words assume.
 */
import type { IrType } from "../../ir/ir.js";
import { SCR_ARR_FIELD } from "./common.js";
import { FN_ATTRS } from "./shapes.js";

export type ArraySearchKind = "ptr" | "cref" | "str";

/** The inline search for arrays of `elem`, or null for the runtime search.
 * `compact`: the arrays hold compact class references (SCR_ELEM_CREF). */
export function arraySearchKind(elem: IrType, compact: boolean): ArraySearchKind | null {
  if (compact) return elem.kind === "object" ? "cref" : null;
  switch (elem.kind) {
    case "object":
    case "record":
    case "array":
    case "map":
    case "set":
    case "bytes":
      return "ptr";
    case "string":
      return "str";
    default:
      return null;
  }
}

export function arraySearchHelperName(kind: ArraySearchKind): string {
  return `sc_arr_index_of_${kind}`;
}

/** The definitions of the helpers in `kinds`; they declare their slow paths
 * through `declare`. */
export function emitArraySearchHelpers(
  kinds: ReadonlySet<ArraySearchKind>,
  sz: string,
  declare: (line: string) => void,
): string[] {
  const defs: string[] = [];
  for (const kind of [...kinds].sort()) {
    declare("declare double @scr_arr_index_of_ref(ptr, ptr)");
    const widen = sz === "i64" ? "  %f = zext i32 %f32 to i64" : "  %f = add i32 %f32, 0";
    defs.push(
      `define internal double @${arraySearchHelperName(kind)}(ptr %a, ptr %v) ${FN_ATTRS} {`,
      `entry:`,
      `  %lenp = getelementptr inbounds %ScrArr, ptr %a, i32 0, i32 1`,
      ...(sz === "i64"
        ? [`  %len32 = load i32, ptr %lenp`, `  %len = zext i32 %len32 to i64`]
        : [`  %len = load i32, ptr %lenp`]),
      `  %fp = getelementptr inbounds %ScrArr, ptr %a, i32 0, i32 6`,
      `  %f32 = load i32, ptr %fp`,
      widen,
      `  %dense = icmp eq ${sz} %f, %len`,
      `  br i1 %dense, label %scan, label %slow`,
      `scan:`,
      `  %dp = getelementptr inbounds %ScrArr, ptr %a, i32 0, i32 ${SCR_ARR_FIELD.data}`,
      `  %data = load ptr, ptr %dp`,
    );
    if (kind === "ptr" || kind === "cref") {
      // A compact reference is the address over 8 (classes.ts
      // compactRefLoadLines).
      const slot = kind === "ptr" ? "i64" : "i32";
      defs.push(
        ...(kind === "ptr"
          ? [`  %needle = ptrtoint ptr %v to i64`]
          : [
              `  %vaddr = ptrtoint ptr %v to i64`,
              `  %vref = lshr i64 %vaddr, 3`,
              `  %needle = trunc i64 %vref to i32`,
            ]),
        // Four slots per step with one branch, then one at a time.
        `  br label %quad`,
        `quad:`,
        `  %q = phi ${sz} [ 0, %scan ], [ %qnext, %quadmiss ]`,
        `  %qend = add ${sz} %q, 4`,
        `  %qfits = icmp ule ${sz} %qend, %len`,
        `  br i1 %qfits, label %quadbody, label %loop`,
        `quadbody:`,
        ...[0, 1, 2, 3].flatMap((k) => [
          `  %qi${k} = add ${sz} %q, ${k}`,
          `  %qp${k} = getelementptr inbounds ${slot}, ptr %data, ${sz} %qi${k}`,
          `  %qs${k} = load ${slot}, ptr %qp${k}`,
          `  %qh${k} = icmp eq ${slot} %qs${k}, %needle`,
        ]),
        `  %qh01 = or i1 %qh0, %qh1`,
        `  %qh23 = or i1 %qh2, %qh3`,
        `  %qhit = or i1 %qh01, %qh23`,
        `  br i1 %qhit, label %loop, label %quadmiss`,
        `quadmiss:`,
        `  %qnext = add ${sz} %q, 4`,
        `  br label %quad`,
        // The single-slot loop finishes the tail, or finds the hit inside a
        // step that had one.
        `loop:`,
        `  %i = phi ${sz} [ %q, %quad ], [ %q, %quadbody ], [ %next, %cont ]`,
        `  %done = icmp eq ${sz} %i, %len`,
        `  br i1 %done, label %miss, label %body`,
        `body:`,
        `  %sp = getelementptr inbounds ${slot}, ptr %data, ${sz} %i`,
        `  %s = load ${slot}, ptr %sp`,
        `  %hit = icmp eq ${slot} %s, %needle`,
        `  br i1 %hit, label %found, label %cont`,
      );
    } else {
      declare("declare zeroext i1 @scr_str_eq(ptr, ptr)");
      defs.push(
        `  %vlp = getelementptr inbounds %ScrStr, ptr %v, i32 0, i32 1`,
        `  %vlen = load ${sz}, ptr %vlp`,
        `  %vdata = getelementptr inbounds %ScrStr, ptr %v, i32 1`,
        `  br label %loop`,
        `loop:`,
        `  %i = phi ${sz} [ 0, %scan ], [ %next, %cont ]`,
        `  %done = icmp eq ${sz} %i, %len`,
        `  br i1 %done, label %miss, label %body`,
        `body:`,
        `  %sp = getelementptr inbounds i64, ptr %data, ${sz} %i`,
        `  %sw = load i64, ptr %sp`,
        `  %s = inttoptr i64 %sw to ptr`,
        `  %same = icmp eq ptr %s, %v`,
        `  br i1 %same, label %found, label %length`,
        `length:`,
        `  %slp = getelementptr inbounds %ScrStr, ptr %s, i32 0, i32 1`,
        `  %slen = load ${sz}, ptr %slp`,
        `  %samelen = icmp eq ${sz} %slen, %vlen`,
        `  br i1 %samelen, label %bytes, label %cont`,
        // Same length: dispatch on it.
        `bytes:`,
        `  %empty = icmp eq ${sz} %vlen, 0`,
        `  br i1 %empty, label %found, label %nonempty`,
        `nonempty:`,
        `  %short = icmp ult ${sz} %vlen, 8`,
        `  br i1 %short, label %tiny, label %wide`,
        `tiny:`,
        `  %sdata = getelementptr inbounds %ScrStr, ptr %s, i32 1`,
        `  %back = sub ${sz} %vlen, 8`,
        `  %sap = getelementptr inbounds i8, ptr %sdata, ${sz} %back`,
        `  %vap = getelementptr inbounds i8, ptr %vdata, ${sz} %back`,
        `  %sa = load i64, ptr %sap, align 1`,
        `  %va = load i64, ptr %vap, align 1`,
        `  %diff = xor i64 %sa, %va`,
        sz === "i64" ? `  %vlen64 = add i64 %vlen, 0` : `  %vlen64 = zext i32 %vlen to i64`,
        `  %bits = shl i64 %vlen64, 3`,
        `  %drop = sub i64 64, %bits`,
        `  %kept = lshr i64 %diff, %drop`,
        `  %tinyeq = icmp eq i64 %kept, 0`,
        `  br i1 %tinyeq, label %found, label %cont`,
        `wide:`,
        `  %fits = icmp ule ${sz} %vlen, 16`,
        `  br i1 %fits, label %two, label %long`,
        `two:`,
        `  %sdata2 = getelementptr inbounds %ScrStr, ptr %s, i32 1`,
        `  %s0 = load i64, ptr %sdata2, align 1`,
        `  %v0 = load i64, ptr %vdata, align 1`,
        `  %tail = sub ${sz} %vlen, 8`,
        `  %s1p = getelementptr inbounds i8, ptr %sdata2, ${sz} %tail`,
        `  %v1p = getelementptr inbounds i8, ptr %vdata, ${sz} %tail`,
        `  %s1 = load i64, ptr %s1p, align 1`,
        `  %v1 = load i64, ptr %v1p, align 1`,
        `  %d0 = xor i64 %s0, %v0`,
        `  %d1 = xor i64 %s1, %v1`,
        `  %d = or i64 %d0, %d1`,
        `  %twoeq = icmp eq i64 %d, 0`,
        `  br i1 %twoeq, label %found, label %cont`,
        `long:`,
        `  %longeq = call zeroext i1 @scr_str_eq(ptr %s, ptr %v)`,
        `  br i1 %longeq, label %found, label %cont`,
      );
    }
    defs.push(
      `cont:`,
      `  %next = add ${sz} %i, 1`,
      `  br label %loop`,
      `found:`,
      `  %at = uitofp ${sz} %i to double`,
      `  ret double %at`,
      `miss:`,
      `  ret double -1.0`,
      `slow:`,
      `  %r = call double @scr_arr_index_of_ref(ptr %a, ptr %v)`,
      `  ret double %r`,
      `}`,
      ``,
    );
  }
  return defs;
}
