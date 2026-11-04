/* Object guard groups, the backend half (shape-tier design 3.3; the plan
 * is ir/js-groups.ts, the record scr_js_group_probe in scr_js_object.c).
 *
 * A group is a run of constant-key reads on one subject inside one
 * statement. Today each read is its own cache site: kind test, layout test,
 * entry compares, slot load. The group tests the subject's layout once and
 * answers every member from one entry that holds all the group's slots:
 *
 *   guard   k = obj+8; k == OBJ else no entry
 *           L = obj+80; L != null else probe
 *           L == @sc_js_group_N+0  -> entry 0
 *           L == @sc_js_group_N+16 -> entry 1
 *           else scr_js_group_probe(obj, @keys, K, @sc_js_group_N)  (cold)
 *   member  entry == null ? the site's helper : slots[i] for i = entry->slot[k]
 *
 * A member after a clobbering operation (one that may run user code, which
 * can change the subject's layout) rechecks the layout against its entry
 * first and takes the helper when it moved. The guard is emitted at the
 * group's first member and every later member reuses its entry value, so
 * the plan's membership must match emission order; a member whose position
 * does not follow the last one emitted takes its plain site. */
import { DYN, STRING, type IrExpr, type IrFunction } from "../../ir/ir.js";
import type { JsGroup, JsGroupMember } from "../../ir/js-groups.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";
import { DYN_KIND } from "./dyn.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { asResult, gep, helperCall, jsIcSiteOf, kindIs, load } from "./js-ic.js";
import { JS_BITS } from "./jsval-encoding.js";

type Host = LlvmEmitterContext;

/** Words of one ScrJsGroup record: four entries of 16 bytes, then count
 * and next (scr_js.h). */
export const JS_GROUP_WORDS = 9;

/** How many entries the guard compares inline. Two is the site's inline
 * way count (js-ic.ts): a group guards the same ties a site does. */
const GUARD_WAYS = 2;
/** Bytes between two entries of a record. */
const WAY_BYTES = 16;
/** Bytes of an entry's slot bytes, at the entry's start. */
const SLOT_BASE = 8;

/** ScrDyn object fields (js-ic.ts). */
const OBJECT_SLOTS = 32;
const OBJECT_LAYOUT = 80;

/** The result of a grouped read of `e`, or null when `e` is not a member
 * whose guard is in effect and the plain site path must answer. */
export function emitGroupedGet(host: Host, e: ExprOf<"call">, callee: IrFunction): LlValue | null {
  const member = host.jsGroupPlan?.member(e);
  if (member === undefined) return null;
  if (jsIcSiteOf(host, e) === null) return null;
  const group = member.group;
  const receiver = emitBorrowedInput(host, e.args[0]!);
  let run = host.groupRuns.get(group);
  if (member.position === 0) {
    run = { entry: emitGuard(host, receiver.name, group, e), next: 0 };
    host.groupRuns.set(group, run);
  } else if (run === undefined || run.next !== member.position) {
    // A member emitted out of order (or without its guard) reads through
    // its own site: the plan's entry does not dominate it.
    return null;
  }
  run.next = member.position + 1;
  return emitMember(host, e, callee, receiver, run.entry, member);
}

/** Emits the guard of `group` on `receiver` in the current block and
 * answers the entry value it found (a record address, or null). */
function emitGuard(host: Host, receiver: string, group: JsGroup, e: IrExpr): string {
  const B = host.B;
  const record = host.jsGroup();
  const keys = host.jsGroupKeys(group.keys.map((key) => keyString(host, key, e)));
  const join = B.newLabel("grp.j");
  const none = B.newLabel("grp.none");
  const shaped = B.newLabel("grp.shape");
  kindIs(host, receiver, DYN_KIND.OBJ, shaped, none);
  B.startBlock(shaped);
  const layout = load(host, "ptr", receiver, OBJECT_LAYOUT);
  const present = B.tmp();
  B.line(`${present} = icmp ne ptr ${layout}, null`);
  const ways: string[] = [];
  const hits: string[] = [];
  const probes: string[] = [];
  for (let way = 0; way < GUARD_WAYS; way++) {
    ways.push(B.newLabel("grp.w"));
    hits.push(B.newLabel("grp.hit"));
  }
  const miss = B.newLabel("grp.miss");
  B.condBr(present, ways[0]!, miss);
  const incoming: string[] = [];
  for (let way = 0; way < GUARD_WAYS; way++) {
    B.startBlock(ways[way]!);
    const cached = load(host, "ptr", record, way * WAY_BYTES);
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${cached}, ${layout}`);
    B.condBr(same, hits[way]!, way + 1 < GUARD_WAYS ? ways[way + 1]! : miss);
    B.startBlock(hits[way]!);
    incoming.push(`[ ${gep(host, record, way * WAY_BYTES)}, %${B.currentLabel()} ]`);
    B.br(join);
  }
  B.startBlock(none);
  probes.push(`[ null, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(miss);
  // The probe answers the layouts the guard does not know, and refuses
  // every object whose layout lacks one of the group's keys.
  host.declare(`declare ptr @scr_js_group_probe(ptr, ptr, i32, ptr)`);
  const probed = B.tmp();
  B.line(
    `${probed} = call ptr @scr_js_group_probe(ptr ${receiver}, ptr ${keys}, i32 ${group.keys.length}, ptr ${record}) cold`,
  );
  probes.push(`[ ${probed}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(join);
  const entry = B.tmp();
  B.line(`${entry} = phi ptr ${[...incoming, ...probes].join(", ")}`);
  return entry;
}

/** Emits one grouped read of `member` through `entry`, with the site's
 * helper as the fallback. */
function emitMember(
  host: Host,
  e: ExprOf<"call">,
  callee: IrFunction,
  receiver: LlValue,
  entry: string,
  member: JsGroupMember,
): LlValue {
  const B = host.B;
  const fast = B.newLabel("grp.fast");
  const slow = B.newLabel("grp.slow");
  const join = B.newLabel("grp.j");
  const ready = B.tmp();
  B.line(`${ready} = icmp ne ptr ${entry}, null`);
  B.condBr(ready, fast, slow);
  const incoming: string[] = [];
  B.startBlock(fast);
  if (member.recheck) {
    // A clobbering operation may have run user code since the guard: the
    // entry answers for the subject only while its layout still holds.
    const now = load(host, "ptr", receiver.name, OBJECT_LAYOUT);
    const entryLayout = load(host, "ptr", entry, 0);
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${now}, ${entryLayout}`);
    const read = B.newLabel("grp.read");
    B.condBr(same, read, slow);
    B.startBlock(read);
  }
  const slots = load(host, "ptr", receiver.name, OBJECT_SLOTS);
  const index = load(host, "i8", entry, SLOT_BASE + member.index);
  const wide = B.tmp();
  B.line(`${wide} = zext i8 ${index} to i64`);
  const address = B.tmp();
  B.line(`${address} = getelementptr inbounds ptr, ptr ${slots}, i64 ${wide}`);
  const cell = load(host, "ptr", address, 0);
  incoming.push(`[ ${asResult(host, cell, e, false)}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(slow);
  incoming.push(`[ ${helperCall(host, e, callee, [receiver])}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(join);
  const value = B.tmp();
  B.line(`${value} = phi ptr ${incoming.join(", ")}`);
  return host.own({ name: value, type: e.type });
}

function keyString(host: Host, key: string, e: IrExpr): string {
  return host.emitExpr({ kind: "strLit", value: key, type: STRING, loc: e.loc }).name;
}

/** The result of a grouped store of `e`, or null when `e` is not a member
 * whose guard is in effect and the plain site path must answer. The store's
 * receiver and value are already evaluated: a member read inside the stored
 * value comes before the store in the group's order.
 *
 * The grouped store is the site's fast branch: the guard has established
 * that the subject is a layout-mode object whose layout holds every key of
 * the group, so the store replaces an existing slot and the shape stays.
 * The value is a static primitive, which the parse region treats as inert,
 * so no write barrier can fire either. */
export function emitGroupedSet(
  host: Host,
  e: ExprOf<"call">,
  callee: IrFunction,
  receiver: LlValue,
  word: string | null,
  value: LlValue | null,
): LlValue | null {
  const member = host.jsGroupPlan?.member(e);
  if (member === undefined || !member.store) return null;
  if (jsIcSiteOf(host, e) === null) return null;
  const B = host.B;
  const group = member.group;
  const open = host.groupRuns.get(group);
  // A member whose guard is not in effect (emitted out of order, or
  // without its guard) stores through its own site.
  if (member.position !== 0 && (open === undefined || open.next !== member.position)) return null;
  let entry: string;
  if (member.position === 0) {
    entry = emitGuard(host, receiver.name, group, e);
    host.groupRuns.set(group, { entry, next: 0 });
  } else {
    entry = open!.entry;
  }
  host.groupRuns.get(group)!.next = member.position + 1;

  // The cell the cold path passes to the helper is boxed lazily there.
  let boxedSlot: string | null = null;
  if (word !== null) {
    boxedSlot = B.slot();
    B.entryAllocas.push(`${boxedSlot} = alloca ptr`);
    B.line(`store ptr null, ptr ${boxedSlot}`);
    host.ownSlot(boxedSlot, DYN);
  }

  const fast = B.newLabel("grp.fast");
  const slow = B.newLabel("grp.slow");
  const join = B.newLabel("grp.j");
  if (word !== null) host.declare(`declare ptr @scr_js_to_dyn_borrow(ptr)`);
  const ready = B.tmp();
  B.line(`${ready} = icmp ne ptr ${entry}, null`);
  B.condBr(ready, fast, slow);
  B.startBlock(fast);
  if (member.recheck) {
    // A clobbering operation may have run user code since the guard: the
    // entry answers for the subject only while its layout still holds.
    const now = load(host, "ptr", receiver.name, OBJECT_LAYOUT);
    const entryLayout = load(host, "ptr", entry, 0);
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${now}, ${entryLayout}`);
    const write = B.newLabel("grp.write");
    B.condBr(same, write, slow);
    B.startBlock(write);
  }
  const slots = load(host, "ptr", receiver.name, OBJECT_SLOTS);
  const index = load(host, "i8", entry, SLOT_BASE + member.index);
  const wide = B.tmp();
  B.line(`${wide} = zext i8 ${index} to i64`);
  const address = B.tmp();
  B.line(`${address} = getelementptr inbounds ptr, ptr ${slots}, i64 ${wide}`);
  const old = B.tmp();
  B.line(`${old} = load ptr, ptr ${address}`);
  if (word === null) {
    B.line(`store ptr ${host.retainHeap(value!.name, DYN)}, ptr ${address}`);
    host.releaseHeap(old, DYN);
    B.br(join);
  } else {
    // A new number replaces the value of an unshared number cell in place;
    // any other value is boxed, and the store takes the box.
    const bits = B.tmp();
    const isDouble = B.tmp();
    B.line(`${bits} = ptrtoint ptr ${word} to i64`);
    B.line(`${isDouble} = icmp ult i64 ${bits}, ${JS_BITS.limit}`);
    const number = B.newLabel("grp.dbl");
    const box = B.newLabel("grp.box");
    B.condBr(isDouble, number, box);
    B.startBlock(number);
    const oldKind = load(host, "i32", old, 8);
    const oldRc = load(host, "i64", old, 0);
    const isNumber = B.tmp();
    const unshared = B.tmp();
    const inPlace = B.tmp();
    B.line(`${isNumber} = icmp eq i32 ${oldKind}, ${DYN_KIND.NUM}`);
    B.line(`${unshared} = icmp eq i64 ${oldRc}, 1`);
    B.line(`${inPlace} = and i1 ${isNumber}, ${unshared}`);
    const update = B.newLabel("grp.inplace");
    B.condBr(inPlace, update, box);
    B.startBlock(update);
    const d = B.tmp();
    B.line(`${d} = bitcast i64 ${bits} to double`);
    B.line(`store double ${d}, ptr ${gep(host, old, 16)}`);
    B.br(join);
    B.startBlock(box);
    const cell = B.tmp();
    B.line(`${cell} = call ptr @scr_js_to_dyn_borrow(ptr ${word})`);
    B.line(`store ptr ${cell}, ptr ${address}`);
    host.releaseHeap(old, DYN);
    B.br(join);
  }
  B.startBlock(slow);
  let cell: string;
  if (word !== null) {
    cell = B.tmp();
    B.line(`${cell} = call ptr @scr_js_to_dyn_borrow(ptr ${word})`);
    B.line(`store ptr ${cell}, ptr ${boxedSlot}`);
  } else {
    cell = value!.name;
  }
  helperCall(host, e, callee, [receiver, { name: cell, type: DYN }]);
  B.br(join);
  B.startBlock(join);
  return { name: "", type: e.type };
}
