/* Runtime guards for checker-proven narrowings.
 *
 * `unionNarrow`, `downcast` and `caughtNarrow` extract a payload whose arm,
 * class or kind TypeScript's control-flow narrowing proved. Emitted code
 * verifies that proof once at the narrowing site: the tag, class interval or
 * caught kind is compared and a mismatch stops the program through the
 * runtime trap funnel instead of reading the payload as the wrong type. The
 * frontend lowers every narrowing it knows it cannot prove through checked
 * extraction, which throws the catchable TypeError, so a failing guard means
 * either a compiler bug or a program whose hand-written type predicate or
 * assertion function (`x is T`, `asserts x is T`) lied about a value's type:
 * TypeScript trusts those claims without checking them. The guard aborts
 * rather than unwinding through code that assumed the extraction could not
 * throw. The guards are cheap: one load and compare per site, which LLVM
 * folds where an identical test already dominates. */
import { InternalCompilerError } from "../../errors.js";
import { classMembershipIntervals, type LlClassMeta } from "./classes.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { vAdapters } from "./shapes.js";

const NARROW_GUARD_HINT = " (a type predicate or assertion may be wrong)\n";

export const NARROW_GUARD_MESSAGES = {
  union: `scriptc: a narrowed value does not have the type its narrowing proved${NARROW_GUARD_HINT}`,
  downcast: `scriptc: a narrowed object is not an instance of the class its narrowing proved${NARROW_GUARD_HINT}`,
  caught: `scriptc: a narrowed catch binding does not have the type its narrowing proved${NARROW_GUARD_HINT}`,
} as const;

/** Continues in a fresh block where `ok` holds; otherwise traps with the
 * message for `kind`. */
export function emitNarrowGuard(
  host: LlvmEmitterContext,
  ok: string,
  kind: keyof typeof NARROW_GUARD_MESSAGES,
): void {
  const B = host.B;
  host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
  host.declare(`declare void @scr_trap(ptr)`);
  const expected = B.tmp();
  B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${ok}, i1 true)`);
  const pass = B.newLabel("narrow.ok");
  const fail = B.newLabel("narrow.bad");
  B.condBr(expected, pass, fail);
  B.startBlock(fail);
  B.line(`call void @scr_trap(ptr ${host.cstr(NARROW_GUARD_MESSAGES[kind])})`);
  B.terminate("unreachable");
  B.startBlock(pass);
}

/** Verifies that the union value `unionName` holds arm `tag`. A two-arm
 * union holds it exactly when it does not hold the other arm; testing the
 * other arm lets LLVM fold the guard under a dominating `!== other` test as
 * well as under `=== tag` (a tag outside the arms is not a union value). */
export function emitUnionNarrowGuard(
  host: LlvmEmitterContext,
  unionName: string,
  unionId: string,
  tag: number,
): void {
  const ok = host.B.tmp();
  const actual = host.unionTag(unionName, unionId);
  if (host.unionsById.get(unionId)?.arms.length === 2)
    host.B.line(`${ok} = icmp ne i32 ${actual}, ${1 - tag}`);
  else host.B.line(`${ok} = icmp eq i32 ${actual}, ${tag}`);
  emitNarrowGuard(host, ok, "union");
}

/** The i1 `instanceof` test of the borrowed object `objName`, statically a
 * `staticClassName`, against `targetClassName`'s preorder intervals. */
export function emitClassMembership(
  host: LlvmEmitterContext,
  objName: string,
  staticClassName: string,
  targetClassName: string,
  comment: string,
): string {
  const B = host.B;
  const target = host.classMetaOf(targetClassName);
  const pre = host.loadVtPre(objName, staticClassName);
  let result: string | undefined;
  for (const interval of classMembershipIntervals(host.classMeta, target.def.name)) {
    const ge = B.tmp(),
      le = B.tmp(),
      test = B.tmp();
    B.line(`${ge} = icmp uge ${host.sizeType} ${pre}, ${interval.pre}`);
    B.line(`${le} = icmp ule ${host.sizeType} ${pre}, ${interval.post}`);
    B.line(`${test} = and i1 ${ge}, ${le} ; ${comment}`);
    if (result === undefined) result = test;
    else {
      const combined = B.tmp();
      B.line(`${combined} = or i1 ${result}, ${test}`);
      result = combined;
    }
  }
  return result!;
}

/** Verifies that the borrowed object `objName` is a `targetClassName`. */
export function emitDowncastGuard(
  host: LlvmEmitterContext,
  objName: string,
  staticClassName: string,
  targetClassName: string,
): void {
  const ok = emitClassMembership(
    host,
    objName,
    staticClassName,
    targetClassName,
    `downcast ${targetClassName}`,
  );
  emitNarrowGuard(host, ok, "downcast");
}

/** The i1 `e instanceof C` test of the borrowed catch snapshot `caught`.
 * Hierarchy classes compare the OBJ payload's vtable preorder; standalone
 * class payloads have no vtable word, so their retain adapter identifies
 * the exact native layout. */
export function emitCaughtInstanceof(
  host: LlvmEmitterContext,
  caught: string,
  className: string,
): string {
  const B = host.B;
  const target = host.classMetaOf(className);
  const intervals = classMembershipIntervals(host.classMeta, target.def.name);
  if (target.idInRc) return emitCaughtClassIdInstanceof(host, caught, target, intervals);
  if (!target.hierarchy) {
    const adapterSlot = B.tmp();
    const adapter = B.tmp();
    B.line(`${adapterSlot} = getelementptr inbounds %ScrCaught, ptr ${caught}, i64 0, i32 5`);
    B.line(`${adapter} = load ptr, ptr ${adapterSlot}`);
    let result: string | undefined;
    for (const candidate of host.classMeta.values()) {
      if (
        candidate.hierarchy ||
        !intervals.some((range) => range.pre <= candidate.pre && candidate.pre <= range.post)
      )
        continue;
      const rc = vAdapters(host.shapeHost, { kind: "object", className: candidate.def.name });
      const matches = B.tmp();
      B.line(`${matches} = icmp eq ptr ${adapter}, ${rc.retain}`);
      if (result === undefined) result = matches;
      else {
        const joined = B.tmp();
        B.line(`${joined} = or i1 ${result}, ${matches}`);
        result = joined;
      }
    }
    if (result === undefined) throw new InternalCompilerError("empty standalone class membership");
    return result;
  }
  host.declare(
    `declare zeroext i1 @scr_caught_instanceof(ptr, ${host.sizeType}, ${host.sizeType})`,
  );
  let result: string | undefined;
  for (const interval of intervals) {
    const test = B.tmp();
    B.line(
      `${test} = call zeroext i1 @scr_caught_instanceof(ptr ${caught}, ${host.sizeType} ${interval.pre}, ${host.sizeType} ${interval.post})`,
    );
    if (result === undefined) result = test;
    else {
      const combined = B.tmp();
      B.line(`${combined} = or i1 ${result}, ${test}`);
      result = combined;
    }
  }
  if (result === undefined) throw new InternalCompilerError("empty class membership");
  return result;
}

/** `e instanceof C` for a class whose instances keep their class id in
 * the rc word (classes.ts LlClassMeta.idInRc). They are thrown as REF
 * payloads, like standalone class instances: the retain adapter names the
 * hierarchy (the adapter of whichever static class threw), and the payload's
 * class id is tested against the intervals. */
function emitCaughtClassIdInstanceof(
  host: LlvmEmitterContext,
  caught: string,
  target: LlClassMeta,
  intervals: { pre: number; post: number }[],
): string {
  const B = host.B;
  const kp = B.tmp(),
    kind = B.tmp(),
    isRef = B.tmp(),
    adapterSlot = B.tmp(),
    adapter = B.tmp();
  B.line(`${kp} = getelementptr inbounds %ScrCaught, ptr ${caught}, i64 0, i32 1`);
  B.line(`${kind} = load i32, ptr ${kp}`);
  B.line(`${isRef} = icmp eq i32 ${kind}, ${CAUGHT_REF_KIND}`);
  B.line(`${adapterSlot} = getelementptr inbounds %ScrCaught, ptr ${caught}, i64 0, i32 5`);
  B.line(`${adapter} = load ptr, ptr ${adapterSlot}`);
  let anyAdapter: string | undefined;
  for (const m of host.classMeta.values()) {
    if (m.root !== target.root) continue;
    const rc = vAdapters(host.shapeHost, { kind: "object", className: m.def.name });
    const matches = B.tmp();
    B.line(`${matches} = icmp eq ptr ${adapter}, ${rc.retain}`);
    if (anyAdapter === undefined) anyAdapter = matches;
    else {
      const joined = B.tmp();
      B.line(`${joined} = or i1 ${anyAdapter}, ${matches}`);
      anyAdapter = joined;
    }
  }
  const inHierarchy = B.tmp();
  B.line(`${inHierarchy} = and i1 ${isRef}, ${anyAdapter!}`);
  const test = B.newLabel("caught.class"),
    join = B.newLabel("caught.class.done"),
    from = B.currentLabel();
  B.condBr(inHierarchy, test, join);
  B.startBlock(test);
  const payloadSlot = B.tmp(),
    payload = B.tmp();
  B.line(`${payloadSlot} = getelementptr inbounds %ScrCaught, ptr ${caught}, i64 0, i32 4`);
  B.line(`${payload} = load ptr, ptr ${payloadSlot}`);
  const pre = host.loadVtPre(payload, target.def.name);
  let result: string | undefined;
  for (const interval of intervals) {
    const ge = B.tmp(),
      le = B.tmp(),
      t = B.tmp();
    B.line(`${ge} = icmp uge ${host.sizeType} ${pre}, ${interval.pre}`);
    B.line(`${le} = icmp ule ${host.sizeType} ${pre}, ${interval.post}`);
    B.line(`${t} = and i1 ${ge}, ${le}`);
    if (result === undefined) result = t;
    else {
      const combined = B.tmp();
      B.line(`${combined} = or i1 ${result}, ${t}`);
      result = combined;
    }
  }
  if (result === undefined) throw new InternalCompilerError("empty class membership");
  const tested = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi i1 [ false, %${from} ], [ ${result}, %${tested} ]`);
  return out;
}

/** SCR_EXC_REF (scr_exception.h). */
const CAUGHT_REF_KIND = 4;

/** SCR_EXC_F64 = 1, SCR_EXC_BOOL = 2, SCR_EXC_STR = 3 (scr_exception.h). */
export const CAUGHT_SCALAR_KINDS = { f64: 1, bool: 2, string: 3 } as const;

/** Verifies that the borrowed catch snapshot `caught` holds a value of the
 * narrowed type: a scalar's kind tag, or an object's class. */
export function emitCaughtNarrowGuard(
  host: LlvmEmitterContext,
  caught: string,
  type: { kind: "f64" | "bool" | "string" } | { kind: "object"; className: string },
): void {
  const B = host.B;
  let ok: string;
  if (type.kind === "object") {
    ok = emitCaughtInstanceof(host, caught, type.className);
  } else {
    const kp = B.tmp();
    const k = B.tmp();
    ok = B.tmp();
    B.line(`${kp} = getelementptr inbounds %ScrCaught, ptr ${caught}, i64 0, i32 1`);
    B.line(`${k} = load i32, ptr ${kp}`);
    B.line(`${ok} = icmp eq i32 ${k}, ${CAUGHT_SCALAR_KINDS[type.kind]}`);
  }
  emitNarrowGuard(host, ok, "caught");
}
