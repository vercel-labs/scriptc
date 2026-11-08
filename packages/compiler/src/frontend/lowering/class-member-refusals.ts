/* Class members refused without rejecting their class.
 *
 * A class whose collection fails is rejected whole: its diagnostics defer
 * under the class symbol and every construction, field read and method
 * call of it reports the cascade (SC1090 / SC2004). For a member that is
 * not part of the layout that is too much: a method, an accessor or a
 * generic method that cannot be compiled changes neither the fields nor
 * the constructor, so the class stays a class and only the member is
 * refused.
 *
 * Which refusals are confined is decided where they are raised
 * (collectClassShapeInner): a refusal confines only when the member keeps
 * a slot every dispatch can reach. Refusals that protect dispatch itself
 * (an override of a statically dispatched async, generator or generic
 * method, a member shadowing an inherited field, a runtime-owned surface)
 * still reject the class, because a base-typed call would silently run
 * the inherited body.
 *
 * A refused member is loud at every reach:
 *  - its slot function throws the refusal at entry (ClassInfo.
 *    methodEntryFences), so a call the build cannot see (an untyped value,
 *    a base-typed receiver dispatching to the override, an interface view)
 *    throws with the diagnostic's code at run time;
 *  - a statically typed use is a build error at the use (SC2004), with the
 *    member's own diagnostics reported once (reportRefusedMemberUse). In a
 *    JavaScript source the statement defers to a run-time fence like every
 *    other refusal there;
 *  - a refused generic member has no slot (generic members dispatch
 *    statically): every instantiation is refused (internGenericInstance)
 *    and a dynamic read or call keeps the run-time refusal generic members
 *    have. */
import type * as ts from "../ts7/adapter.js";
import { blockedBindingUseDiag, type ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { locOf } from "../program.js";
import type { ClassInfo } from "./lower-classes.js";
import { PoisonError, type Lowerer } from "./lowerer.js";

/** One refused member. */
export interface RefusedClassMember {
  /** `Class.member`, as the use diagnostics spell it. */
  display: string;
  /** The declaration's own diagnostics: reported once, when the first
   * statically visible use reaches the build. */
  diags: ScrDiagnostic[];
}

/** Where the diagnostics of the member being collected start
 * (takeMemberRefusal). */
export function memberRefusalMark(lowerer: Lowerer): number {
  return lowerer.diagSink !== null ? lowerer.diagSink.length : lowerer.diags.length;
}

/** The refusal of the member collected since `mark`, or null when the
 * member is not confined: the declaration flush retry can still clear one
 * of its diagnostics (a type it degrades to a checked-dynamic slot), which
 * compiles the member, so the refusal stays the class's as before.
 *
 * The diagnostics leave the buffer they were pushed to. Under a capture
 * buffer (a class collected with deferral) they would otherwise count
 * against the class: a later class-level failure defers them with its
 * own, and the flush retry gives up on a list that holds a diagnostic it
 * cannot degrade. Without a buffer they would fail the build. */
export function takeMemberRefusal(
  lowerer: Lowerer,
  mark: number,
  display: string,
): RefusedClassMember | null {
  const buffer = lowerer.diagSink ?? lowerer.diags;
  if (lowerer.declarationRetryMayClear(buffer.slice(mark))) return null;
  return { display, diags: buffer.splice(mark) };
}

/** A statically visible use of a refused member: the member's diagnostics
 * (once: pushDiag drops exact repeats) and the cascade at the use. */
export function reportRefusedMemberUse(
  lowerer: Lowerer,
  refused: RefusedClassMember,
  use: ts.Node,
): never {
  for (const diag of refused.diags) lowerer.pushDiag(diag);
  lowerer.pushDiag(blockedBindingUseDiag(refused.display, locOf(use)));
  throw new PoisonError();
}

/** Reports a use of the static `name` through `info` when the class that
 * declares the name (the nearest one on the base chain) left it out
 * because its signature has no mapping. */
export function checkRefusedStaticUse(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
  use: ts.Node,
): void {
  for (let c: ClassInfo | null | undefined = info; c; c = c.base) {
    const refused = c.refusedStatics?.get(name);
    if (refused !== undefined) reportRefusedMemberUse(lowerer, refused, use);
    if (c.declaredStatics?.has(name) === true) return;
  }
}

/** A plain assignment through an accessor target reports the refused
 * setter before the value lowers against the property's type. */
export function checkRefusedAccessorWrite(
  lowerer: Lowerer,
  target: { container: string; className?: string; field: string },
  use: ts.Node,
): void {
  if (target.container !== "accessor" || target.className === undefined) return;
  const setter = lowerer.findMethodOn(
    lowerer.classes.get(target.className) ?? null,
    `set:${target.field}`,
  );
  if (setter) checkRefusedMemberUse(lowerer, setter.declarer, `set:${target.field}`, use);
}

/** Reports a use of `key` ("m", "get:x", "set:x") when the class that
 * declares it refused the member. */
export function checkRefusedMemberUse(
  lowerer: Lowerer,
  declarer: ClassInfo,
  key: string,
  use: ts.Node,
): void {
  const refused = declarer.refusedMembers?.get(key);
  if (refused !== undefined) reportRefusedMemberUse(lowerer, refused, use);
}
