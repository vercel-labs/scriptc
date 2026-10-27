/* Inline-cache lowering of the dynamic tier (two-tier design stage S4;
 * runtime scr_js_object.c, sites ir/js-ic.ts).
 *
 * A property site in a dynamic-tier function owns one zeroed thread-local
 * ScrJsIc record (`@sc_js_ic_N`). The code at the site is fixed:
 *
 *   load   ordinary object whose shape is entry 0's own-property shape:
 *          read entry `slot` inline unless it is an accessor; otherwise
 *          scr_js_get_probe (polymorphic, prototype hits, absent keys,
 *          misses)
 *   store  ordinary object whose shape is entry 0's replace shape, outside
 *          an intact parse region, writable data entry: replace inline;
 *          otherwise scr_js_store_probe (adds, polymorphic, misses)
 *   keyed  dense array element at an integral number key: inline;
 *          otherwise scr_js_keyed_probe (string keys of ordinary objects)
 *   method dynInvoke's method read: scr_js_load_probe
 *   literal an object literal's constant-key member: scr_js_store_probe,
 *          else scr_dyn_key_set
 *
 * A probe that cannot answer from plain data leaves everything untouched,
 * and the site calls its helper (or the generic runtime entry), which
 * defines the operation's semantics; nothing is ever patched.
 *
 * Layout facts (64-bit only; 32-bit targets keep the helper calls):
 *   ScrDyn       kind +8; v.obj {len +16, entries +32, region +72,
 *                shape +80}; v.arr {len +16, items +32, presence +56};
 *                v.num +16
 *   ScrDynEntry  48 bytes: value +16, accessor bit 0 of +40, writable +41
 *   ScrJsIc      entries of 40 bytes {shape, target, holder, holder_shape,
 *                slot}; 168 bytes in all */
import { BOOL, DYN, F64, STRING, type IrExpr, type IrFunction } from "../../ir/ir.js";
import { jsIcMethodSites, type JsIcSite } from "../../ir/js-ic.js";
import { mangleBorrowedFunction } from "../mangle.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";
import { DYN_KIND } from "./dyn.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { JS_BITS } from "./jsval-encoding.js";
import { jsImmediates } from "./jsval.js";

type Host = LlvmEmitterContext;

/** Words of one ScrJsIc record. */
export const JS_IC_WORDS = 21;

const ENTRY_STRIDE = 48;

/** The cache site a call is, when it is emitted in a dynamic-tier function
 * of a 64-bit target. */
export function jsIcSiteOf(host: Host, e: ExprOf<"call">): JsIcSite | null {
  if (!jsImmediates(host) || host.currentTier !== "dynamic") return null;
  if (host.int32Abis.has(e.callee)) return null;
  return host.jsIcSites.site(e.callee);
}

/** Whether method dispatch in the current function reads through a cache. */
export function jsIcMethods(host: Host): boolean {
  return (
    jsImmediates(host) &&
    host.currentTier === "dynamic" &&
    jsIcMethodSites(host.currentFunctionName)
  );
}

function gep(host: Host, base: string, offset: number): string {
  const p = host.B.tmp();
  host.B.line(`${p} = getelementptr inbounds i8, ptr ${base}, i64 ${offset}`);
  return p;
}

function load(host: Host, type: string, base: string, offset: number): string {
  const v = host.B.tmp();
  host.B.line(`${v} = load ${type}, ptr ${offset === 0 ? base : gep(host, base, offset)}`);
  return v;
}

/** Branches to `yes` when the dyn cell `d` has kind `kind`. */
function kindIs(host: Host, d: string, kind: number, yes: string, no: string): void {
  const k = load(host, "i32", d, 8);
  const is = host.B.tmp();
  host.B.line(`${is} = icmp eq i32 ${k}, ${kind}`);
  host.B.condBr(is, yes, no);
}

/* How many cache entries a site tests inline, and whether those tests
 * cover prototype hits. Measured (two-tier S4): testing all four entries
 * inline made polymorphic reads 7-10% faster (the design prototype's W2/W3)
 * and monomorphic method code no faster, for 65-225 more bytes per site;
 * the prototype hit made method-heavy code 3-6% faster for 15-90 bytes.
 * So a site tests entry 0, own or prototype, and its probe does the rest.
 * (0 makes every access probe: with a runtime built with SCR_JS_VERIFY,
 * that checks every cached shape against its object.) */
const INLINE_WAYS: number = 1;
const INLINE_PROTO = true;

/** The address of entry `slot` of object `d`'s entries. */
function entryAt(host: Host, d: string, slot: string): string {
  const B = host.B;
  const entries = load(host, "ptr", d, 32);
  const offset = B.tmp();
  const entry = B.tmp();
  B.line(`${offset} = mul i64 ${slot}, ${ENTRY_STRIDE}`);
  B.line(`${entry} = getelementptr inbounds i8, ptr ${entries}, i64 ${offset}`);
  return entry;
}

/** Branches to `miss` when the entry at `entry` is an accessor. */
function dataEntry(host: Host, entry: string, miss: string): void {
  const B = host.B;
  const flags = load(host, "i8", entry, 40);
  const accessor = B.tmp();
  const isAccessor = B.tmp();
  B.line(`${accessor} = and i8 ${flags}, 1`);
  B.line(`${isAccessor} = icmp ne i8 ${accessor}, 0`);
  const data = B.newLabel("ic.data");
  B.condBr(isAccessor, miss, data);
  B.startBlock(data);
}

/** The inline part of a load site, entered for an ordinary object `d`:
 * tests the first `ways` cache entries (own properties, and prototype hits
 * when `proto`); each hit converts the (borrowed) value with `result` and
 * branches to `join`, recording its phi input. Anything else branches to
 * `miss`. */
function inlineLoad(
  host: Host,
  d: string,
  ic: string,
  ways: number,
  proto: boolean,
  result: (cell: string) => string,
  incoming: string[],
  join: string,
  miss: string,
): void {
  const B = host.B;
  if (ways === 0) {
    B.br(miss);
    return;
  }
  const shape = load(host, "ptr", d, 80);
  const present = B.tmp();
  B.line(`${present} = icmp ne ptr ${shape}, null`);
  let next = B.newLabel("ic.w");
  B.condBr(present, next, miss);
  for (let way = 0; way < ways; way++) {
    const base = way * 40;
    B.startBlock(next);
    next = way + 1 < ways ? B.newLabel("ic.w") : miss;
    const cached = load(host, "ptr", ic, base);
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${shape}, ${cached}`);
    const matched = B.newLabel("ic.m");
    B.condBr(same, matched, next);
    B.startBlock(matched);
    const target = load(host, "ptr", ic, base + 8);
    const own = B.tmp();
    B.line(`${own} = icmp eq ptr ${target}, null`);
    const ownLabel = B.newLabel("ic.own");
    const protoLabel = proto ? B.newLabel("ic.proto") : miss;
    B.condBr(own, ownLabel, protoLabel);
    const hit = (holder: string): void => {
      const slot = load(host, "i64", ic, base + 32);
      const entry = entryAt(host, holder, slot);
      dataEntry(host, entry, miss);
      const value = load(host, "ptr", entry, 16);
      const out = result(value);
      incoming.push(`[ ${out}, %${B.currentLabel()} ]`);
      B.br(join);
    };
    B.startBlock(ownLabel);
    hit(d);
    if (!proto) continue;
    B.startBlock(protoLabel);
    const holder = load(host, "ptr", ic, base + 16);
    const prototype = load(host, "ptr", d, 96);
    const linked = B.tmp();
    B.line(`${linked} = icmp eq ptr ${prototype}, ${holder}`);
    const isLinked = B.newLabel("ic.pl");
    B.condBr(linked, isLinked, miss);
    B.startBlock(isLinked);
    const holderObject = B.newLabel("ic.po");
    kindIs(host, holder, DYN_KIND.OBJ, holderObject, miss);
    B.startBlock(holderObject);
    const holderShape = load(host, "ptr", holder, 80);
    const current = B.tmp();
    B.line(`${current} = icmp eq ptr ${holderShape}, ${target}`);
    const holderHit = B.newLabel("ic.ph");
    B.condBr(current, holderHit, miss);
    B.startBlock(holderHit);
    hit(holder);
  }
}

/** The inline part of a store site that replaces an own data property,
 * entered for an ordinary object `d` outside an intact parse region:
 * tests the first `ways` cache entries; a hit calls `store` with the
 * address of the entry's value word, which must end its block by
 * branching to the site's join. */
function inlineReplace(
  host: Host,
  d: string,
  ic: string,
  ways: number,
  store: (slot: string) => void,
  miss: string,
): void {
  const B = host.B;
  if (ways === 0) {
    B.br(miss);
    return;
  }
  const shape = load(host, "ptr", d, 80);
  const present = B.tmp();
  B.line(`${present} = icmp ne ptr ${shape}, null`);
  let next = B.newLabel("ic.w");
  B.condBr(present, next, miss);
  for (let way = 0; way < ways; way++) {
    const base = way * 40;
    B.startBlock(next);
    next = way + 1 < ways ? B.newLabel("ic.w") : miss;
    const cached = load(host, "ptr", ic, base);
    const target = load(host, "ptr", ic, base + 8);
    const same = B.tmp();
    const replace = B.tmp();
    const ok = B.tmp();
    B.line(`${same} = icmp eq ptr ${shape}, ${cached}`);
    B.line(`${replace} = icmp eq ptr ${target}, ${shape}`);
    B.line(`${ok} = and i1 ${same}, ${replace}`);
    const matched = B.newLabel("ic.m");
    B.condBr(ok, matched, next);
    B.startBlock(matched);
    const slot = load(host, "i64", ic, base + 32);
    const entry = entryAt(host, d, slot);
    const flags = load(host, "i8", entry, 40);
    const writable = load(host, "i8", entry, 41);
    const accessor = B.tmp();
    const data = B.tmp();
    const canWrite = B.tmp();
    const writes = B.tmp();
    B.line(`${accessor} = and i8 ${flags}, 1`);
    B.line(`${data} = icmp eq i8 ${accessor}, 0`);
    B.line(`${canWrite} = icmp ne i8 ${writable}, 0`);
    B.line(`${writes} = and i1 ${data}, ${canWrite}`);
    const hit = B.newLabel("ic.st");
    B.condBr(writes, hit, miss);
    B.startBlock(hit);
    store(gep(host, entry, 16));
  }
}

/** A property value (a dyn cell, `owned` or borrowed from its entry) as
 * the site's result type, owned. A jsval result reads a number cell as an
 * immediate, so arithmetic on it takes no reference and a later store can
 * update an unshared number cell in place; any other cell is carried under
 * the cell tag. */
function asResult(host: Host, cell: string, e: IrExpr, owned: boolean | string): string {
  const B = host.B;
  /** Retains the cell unless the caller owns it. */
  const hold = (): string => {
    if (owned === true) return cell;
    if (owned === false) return host.retainFrame(cell, DYN);
    const borrowed = B.newLabel("icr.b");
    const done = B.newLabel("icr.h");
    const from = B.currentLabel();
    B.condBr(owned, done, borrowed);
    B.startBlock(borrowed);
    const retained = host.retainFrame(cell, DYN);
    const retainedEnd = B.currentLabel();
    B.br(done);
    B.startBlock(done);
    const held = B.tmp();
    B.line(`${held} = phi ptr [ ${cell}, %${from} ], [ ${retained}, %${retainedEnd} ]`);
    return held;
  };
  if (e.type.kind !== "jsval") return hold();
  const number = B.newLabel("icr.num");
  const other = B.newLabel("icr.cell");
  const join = B.newLabel("icr.j");
  kindIs(host, cell, DYN_KIND.NUM, number, other);
  B.startBlock(number);
  const d = load(host, "double", cell, 16);
  const raw = B.tmp();
  const nan = B.tmp();
  const bits = B.tmp();
  B.line(`${raw} = bitcast double ${d} to i64`);
  B.line(`${nan} = fcmp uno double ${d}, ${d}`);
  B.line(`${bits} = select i1 ${nan}, i64 ${JS_BITS.canonicalNan}, i64 ${raw}`);
  const immediate = B.tmp();
  B.line(`${immediate} = inttoptr i64 ${bits} to ptr`);
  if (owned === true) {
    host.releaseFrame(cell, DYN);
  } else if (owned !== false) {
    const release = B.newLabel("icr.r");
    const released = B.newLabel("icr.rd");
    B.condBr(owned, release, released);
    B.startBlock(release);
    host.releaseFrame(cell, DYN);
    B.br(released);
    B.startBlock(released);
  }
  const numberEnd = B.currentLabel();
  B.br(join);
  B.startBlock(other);
  const held = hold();
  const cellBits = B.tmp();
  const word = B.tmp();
  const tagged = B.tmp();
  B.line(`${cellBits} = ptrtoint ptr ${held} to i64`);
  B.line(`${word} = or i64 ${cellBits}, ${JS_BITS.cellTag}`);
  B.line(`${tagged} = inttoptr i64 ${word} to ptr`);
  const otherEnd = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi ptr [ ${immediate}, %${numberEnd} ], [ ${tagged}, %${otherEnd} ]`);
  return out;
}

/** The helper call of a site's slow path, with the site's evaluated
 * (borrowed) arguments. Ordinary parameters take a reference; borrowed
 * ones lend it. Returns the owned result, or "" for a void helper. */
function helperCall(host: Host, e: ExprOf<"call">, callee: IrFunction, args: LlValue[]): string {
  const B = host.B;
  const borrowed = host.callLifetimes.borrowed.get(e.callee);
  const argList = args
    .map((a, i) => {
      const type = callee.params[i]!.type;
      const value = borrowed?.has(i) ? a.name : host.retainFrame(a.name, a.type);
      return `${host.llType(type)} ${value}`;
    })
    .join(", ");
  const target = `@${borrowed ? mangleBorrowedFunction(e.callee) : host.callTarget(e.callee)}`;
  // The helper is the site's cold path: keep its body out of line.
  if (e.type.kind === "void") {
    B.line(`call void ${target}(${argList}) noinline cold`);
    if (host.mayThrow.has(e.callee)) host.emitPendingCheck();
    return "";
  }
  let t = B.tmp();
  B.line(`${t} = call ${host.llType(e.type)} ${target}(${argList}) noinline cold`);
  if (host.mayThrow.has(e.callee)) host.emitPendingCheck();
  if (borrowed && host.borrowedReturns.has(e.callee)) t = host.retainFrame(t, e.type);
  return t;
}

function keyString(host: Host, key: string, e: IrExpr): string {
  return host.emitExpr({ kind: "strLit", value: key, type: STRING, loc: e.loc }).name;
}

/** Emits a call to a classified helper as a cache site. */
export function emitJsIcCall(
  host: Host,
  e: ExprOf<"call">,
  callee: IrFunction,
  site: JsIcSite,
): LlValue {
  switch (site.kind) {
    case "get":
      return emitGet(host, e, callee, site.key);
    case "set":
      return emitSet(host, e, callee, site.key);
    case "keyed":
      return emitKeyed(host, e, callee);
    case "keyedSet":
      return emitKeyedSet(host, e, callee, site.stringKey);
  }
}

/** A computed store `o[k] = v`: an ordinary object and a string key that
 * names no array index take the shape transition (shared key bytes, the
 * shape the next object of the same build reuses); anything else calls the
 * helper. The key varies per call, so the site keeps no cache entry. */
function emitKeyedSet(
  host: Host,
  e: ExprOf<"call">,
  callee: IrFunction,
  stringKey: boolean,
): LlValue {
  const B = host.B;
  const receiver = emitBorrowedInput(host, e.args[0]!);
  const key = emitBorrowedInput(host, e.args[1]!);
  const value = emitBorrowedInput(host, e.args[2]!);
  const probe = stringKey ? "scr_js_keyed_store_probe_str" : "scr_js_keyed_store_probe";
  host.declare(`declare zeroext i1 @${probe}(ptr, ptr, ptr)`);
  const done = B.tmp();
  B.line(
    `${done} = call zeroext i1 @${probe}(ptr ${receiver.name}, ptr ${key.name}, ptr ${value.name})`,
  );
  const slow = B.newLabel("icks.slow");
  const join = B.newLabel("icks.j");
  B.condBr(done, join, slow);
  B.startBlock(slow);
  helperCall(host, e, callee, [receiver, key, value]);
  B.br(join);
  B.startBlock(join);
  return { name: "", type: e.type };
}

function emitGet(host: Host, e: ExprOf<"call">, callee: IrFunction, key: string): LlValue {
  const B = host.B;
  const receiver = emitBorrowedInput(host, e.args[0]!);
  const name = keyString(host, key, e);
  const ic = host.jsIcSite();
  const object = B.newLabel("icg.obj");
  const probe = B.newLabel("icg.probe");
  const slow = B.newLabel("icg.slow");
  const join = B.newLabel("icg.j");
  const incoming: string[] = [];
  if (key === "length") {
    // An array's length is its element count (the generic read answers
    // it before any property table).
    const array = B.newLabel("icg.arr");
    const other = B.newLabel("icg.other");
    kindIs(host, receiver.name, DYN_KIND.ARR, array, other);
    B.startBlock(array);
    const len = load(host, "i64", receiver.name, 16);
    const count = B.tmp();
    B.line(`${count} = uitofp i64 ${len} to double`);
    incoming.push(`[ ${numberResult(host, count, e)}, %${B.currentLabel()} ]`);
    B.br(join);
    B.startBlock(other);
    // So is the length of a native array passed in from typed code.
    const rest = B.newLabel("icg.rest");
    const arr = nativeArray(host, receiver.name, rest);
    const native = load(host, "i32", arr, 8);
    const nativeCount = B.tmp();
    B.line(`${nativeCount} = uitofp i32 ${native} to double`);
    incoming.push(`[ ${numberResult(host, nativeCount, e)}, %${B.currentLabel()} ]`);
    B.br(join);
    B.startBlock(rest);
  }
  if (key === "length" || key === "byteLength") {
    // A typed array's sizes, unless an own property shadows them.
    const bytes = B.newLabel("icg.bytes");
    const sized = B.newLabel("icg.sized");
    const rest = B.newLabel("icg.nbytes");
    kindIs(host, receiver.name, DYN_KIND.BYTES, bytes, rest);
    B.startBlock(bytes);
    host.declare(`declare double @scr_dyn_bytes_size(ptr, i1 zeroext)`);
    const size = B.tmp();
    const known = B.tmp();
    B.line(
      `${size} = call double @scr_dyn_bytes_size(ptr ${receiver.name}, i1 zeroext ${key === "byteLength"})`,
    );
    B.line(`${known} = fcmp oge double ${size}, 0.0`);
    B.condBr(known, sized, rest);
    B.startBlock(sized);
    incoming.push(`[ ${numberResult(host, size, e)}, %${B.currentLabel()} ]`);
    B.br(join);
    B.startBlock(rest);
  }
  // Inline hits (borrowed values) and probe hits (owned ones) share one
  // conversion to the result type.
  const hit = B.newLabel("icg.hit");
  const hits: string[] = [];
  const capsule = B.newLabel("icg.rec");
  kindIs(host, receiver.name, DYN_KIND.OBJ, object, capsule);
  B.startBlock(object);
  inlineLoad(host, receiver.name, ic, INLINE_WAYS, INLINE_PROTO, (cell) => cell, hits, hit, probe);
  B.startBlock(capsule);
  inlineRecordField(host, receiver.name, ic, hits, hit, probe);
  B.startBlock(probe);
  // The read's probe also answers keys the receiver's plain chain lacks.
  // Only `length` and `next` reads can be answered for a native array or
  // iterator, so only those sites take the probe that tests them.
  const probeFn =
    key === "length" || key === "next" ? "scr_js_get_probe_native" : "scr_js_get_probe";
  host.declare(`declare ptr @${probeFn}(ptr, ptr, ptr)`);
  const probed = B.tmp();
  B.line(`${probed} = call ptr @${probeFn}(ptr ${receiver.name}, ptr ${name}, ptr ${ic})`);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${probed}, null`);
  const probeEnd = B.currentLabel();
  B.condBr(found, hit, slow);
  B.startBlock(hit);
  const cell = B.tmp();
  const owned = B.tmp();
  const ownedIn = hits.map((h) => h.replace(/^\[ [^,]+,/, "[ false,"));
  B.line(`${cell} = phi ptr ${[...hits, `[ ${probed}, %${probeEnd} ]`].join(", ")}`);
  B.line(`${owned} = phi i1 ${[...ownedIn, `[ true, %${probeEnd} ]`].join(", ")}`);
  {
    const out = asResult(host, cell, e, owned);
    incoming.push(`[ ${out}, %${B.currentLabel()} ]`);
  }
  B.br(join);
  B.startBlock(slow);
  const result = helperCall(host, e, callee, [receiver]);
  incoming.push(`[ ${result}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi ptr ${incoming.join(", ")}`);
  return host.own({ name: out, type: e.type });
}

/** A number as the site's result type: an immediate for a jsval result,
 * a fresh cell (as the generic read makes) for a dyn one. */
function numberResult(host: Host, d: string, e: IrExpr): string {
  const B = host.B;
  if (e.type.kind === "jsval") {
    // Counts are never NaN: the bits are the word.
    const bits = B.tmp();
    const word = B.tmp();
    B.line(`${bits} = bitcast double ${d} to i64`);
    B.line(`${word} = inttoptr i64 ${bits} to ptr`);
    return word;
  }
  host.declare(`declare ptr @scr_dyn_new_num(double)`);
  const cell = B.tmp();
  B.line(`${cell} = call ptr @scr_dyn_new_num(double ${d})`);
  return cell;
}

function emitSet(host: Host, e: ExprOf<"call">, callee: IrFunction, key: string): LlValue {
  const B = host.B;
  const receiver = emitBorrowedInput(host, e.args[0]!);
  // A value the jsval pass left as `js.toDyn(x)` is stored from the jsval
  // itself: a number replaces the value of an unshared number cell in
  // place instead of boxing a new one.
  const stored = e.args[1]!;
  const word =
    stored.kind === "libCall" && stored.fn === "js.toDyn"
      ? host.emitExpr(stored.args[0]!).name
      : null;
  const value = word === null ? emitBorrowedInput(host, stored) : null;
  const name = keyString(host, key, e);
  const ic = host.jsIcSite();
  const object = B.newLabel("ics.obj");
  const probe = B.newLabel("ics.probe");
  const slow = B.newLabel("ics.slow");
  const join = B.newLabel("ics.j");
  // The cell the probe and the helper store when the value is a jsval;
  // the statement's frame releases it.
  let boxedSlot: string | null = null;
  if (word !== null) {
    boxedSlot = B.slot();
    B.entryAllocas.push(`${boxedSlot} = alloca ptr`);
    B.line(`store ptr null, ptr ${boxedSlot}`);
    host.ownSlot(boxedSlot, DYN);
  }
  kindIs(host, receiver.name, DYN_KIND.OBJ, object, probe);
  B.startBlock(object);
  const region = load(host, "ptr", receiver.name, 72);
  const outside = B.tmp();
  B.line(`${outside} = icmp eq ptr ${region}, null`);
  const unshared = B.newLabel("ics.r");
  B.condBr(outside, unshared, probe);
  B.startBlock(unshared);
  host.declare(`declare ptr @scr_js_to_dyn_borrow(ptr)`);
  inlineReplace(
    host,
    receiver.name,
    ic,
    INLINE_WAYS,
    (slot) => {
      const old = B.tmp();
      B.line(`${old} = load ptr, ptr ${slot}`);
      if (word === null) {
        B.line(`store ptr ${host.retainHeap(value!.name, DYN)}, ptr ${slot}`);
        host.releaseHeap(old, DYN);
        B.br(join);
        return;
      }
      const bits = B.tmp();
      const isDouble = B.tmp();
      B.line(`${bits} = ptrtoint ptr ${word} to i64`);
      B.line(`${isDouble} = icmp ult i64 ${bits}, ${JS_BITS.limit}`);
      const number = B.newLabel("ics.dbl");
      const box = B.newLabel("ics.box");
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
      const update = B.newLabel("ics.inplace");
      B.condBr(inPlace, update, box);
      B.startBlock(update);
      const d = B.tmp();
      B.line(`${d} = bitcast i64 ${bits} to double`);
      B.line(`store double ${d}, ptr ${gep(host, old, 16)}`);
      B.br(join);
      B.startBlock(box);
      const cell = B.tmp();
      B.line(`${cell} = call ptr @scr_js_to_dyn_borrow(ptr ${word})`);
      B.line(`store ptr ${cell}, ptr ${slot}`);
      host.releaseHeap(old, DYN);
      B.br(join);
    },
    probe,
  );
  B.startBlock(probe);
  let cell: string;
  if (word !== null) {
    cell = B.tmp();
    B.line(`${cell} = call ptr @scr_js_to_dyn_borrow(ptr ${word})`);
    B.line(`store ptr ${cell}, ptr ${boxedSlot}`);
  } else {
    cell = value!.name;
  }
  host.declare(`declare zeroext i1 @scr_js_store_probe(ptr, ptr, ptr, ptr)`);
  const done = B.tmp();
  B.line(
    `${done} = call zeroext i1 @scr_js_store_probe(ptr ${receiver.name}, ptr ${name}, ptr ${cell}, ptr ${ic})`,
  );
  B.condBr(done, join, slow);
  B.startBlock(slow);
  helperCall(host, e, callee, [receiver, { name: cell, type: DYN }]);
  B.br(join);
  B.startBlock(join);
  return { name: "", type: e.type };
}

/** A keyed site's key when it is a static number boxed for the helper
 * (`dynFrom(n)`, or `dynFrom(u)` of a local union with a number arm): the
 * site indexes with the double and boxes the key only on a miss. */
interface NumberKey {
  /** i1: whether `value` holds the key (always for a static number). */
  present: string;
  value: string;
  /** Emits the key's cell (+1), exactly as the helper argument boxes it. */
  box: () => string;
}

function numberKey(host: Host, key: IrExpr): NumberKey | null {
  if (key.kind !== "dynFrom" || key.liveRef !== undefined || key.fnName !== undefined) return null;
  const source = key.value;
  if (source.type.kind === "f64") {
    const value = host.emitExpr(source).name;
    // Request the converter where the boxing it replaces did: converters
    // are numbered in request order.
    const conv = host.dyn.toDynHelper(source.type);
    return {
      present: "true",
      value,
      box: () => {
        const cell = host.B.tmp();
        host.B.line(`${cell} = call ptr @${conv}(double ${value})`);
        return cell;
      },
    };
  }
  if (source.type.kind !== "union" || source.kind !== "varRef") return null;
  const unionId = source.type.unionId;
  const tag = host.unionsById.get(unionId)?.arms.findIndex((arm) => arm.kind === "f64") ?? -1;
  if (tag < 0) return null;
  const B = host.B;
  const present = host.emitExpr({
    kind: "unionIsTag",
    unionId,
    tag,
    negated: false,
    value: source,
    type: BOOL,
    loc: key.loc,
  }).name;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca double`);
  B.line(`store double 0.0, ptr ${slot}`);
  const number = B.newLabel("ick.k");
  const done = B.newLabel("ick.kd");
  B.condBr(present, number, done);
  B.startBlock(number);
  // Temps of a conditional block are released in it.
  host.frames.push([]);
  const d = host.emitExpr({
    kind: "unionNarrow",
    unionId,
    tag,
    value: source,
    type: F64,
    loc: key.loc,
  });
  B.line(`store double ${d.name}, ptr ${slot}`);
  host.releaseTemps(host.frames.pop()!);
  B.br(done);
  B.startBlock(done);
  const value = B.tmp();
  B.line(`${value} = load double, ptr ${slot}`);
  return {
    present,
    value,
    box: () => {
      // The local is a plain read: boxing it again evaluates nothing else.
      host.frames.push([]);
      const boxed = host.emitExpr(key);
      host.toFrame(boxed);
      host.releaseTemps(host.frames.pop()!);
      return boxed.name;
    },
  };
}

/** Branches to `yes` when `d` is a capsule of a native array passed in
 * from typed code (a TYPED_REF bound to live array ops, not a record or
 * class instance), with the ScrArr in `yes`; else to `no`. */
/** A record capsule answering from its native record (no view yet) whose
 * layout a cache way names (the probe's record entries: the ops table as
 * the shape, the field index as the slot): a field the record stores as a
 * checked value is read in place (ScrDynTypedRecordOps.dyn_offsets). Its
 * borrowed cell joins `incoming` at `join`; everything else goes to `miss`. */
function inlineRecordField(
  host: Host,
  d: string,
  ic: string,
  incoming: string[],
  join: string,
  miss: string,
): void {
  const B = host.B;
  const flagged = B.newLabel("icr.flags");
  const live = B.newLabel("icr.live");
  kindIs(host, d, DYN_KIND.TYPED_REF, flagged, miss);
  B.startBlock(flagged);
  // `record` alone among the flag word's top three bits.
  const flags = load(host, "i32", d, 88);
  const kinds = B.tmp();
  const record = B.tmp();
  B.line(`${kinds} = lshr i32 ${flags}, 29`);
  B.line(`${record} = icmp eq i32 ${kinds}, 1`);
  const unviewed = B.newLabel("icr.native");
  B.condBr(record, unviewed, miss);
  B.startBlock(unviewed);
  const view = load(host, "ptr", d, 72);
  const none = B.tmp();
  B.line(`${none} = icmp eq ptr ${view}, null`);
  B.condBr(none, live, miss);
  B.startBlock(live);
  const ops = load(host, "ptr", d, 64);
  let next = B.newLabel("icr.w");
  B.br(next);
  for (let way = 0; way < INLINE_WAYS; way++) {
    const base = way * 40;
    B.startBlock(next);
    next = way + 1 < INLINE_WAYS ? B.newLabel("icr.w") : miss;
    const cached = load(host, "ptr", ic, base);
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${ops}, ${cached}`);
    const matched = B.newLabel("icr.m");
    B.condBr(same, matched, next);
    B.startBlock(matched);
    const slot = load(host, "i64", ic, base + 32);
    const count = load(host, "i64", ops, 0);
    const inRange = B.tmp();
    B.line(`${inRange} = icmp ult i64 ${slot}, ${count}`);
    const ranged = B.newLabel("icr.slot");
    B.condBr(inRange, ranged, miss);
    B.startBlock(ranged);
    const offsets = load(host, "ptr", ops, 64);
    const table = B.tmp();
    B.line(`${table} = icmp ne ptr ${offsets}, null`);
    const tabled = B.newLabel("icr.off");
    B.condBr(table, tabled, miss);
    B.startBlock(tabled);
    const offsetPtr = B.tmp();
    B.line(`${offsetPtr} = getelementptr inbounds i32, ptr ${offsets}, i64 ${slot}`);
    const offset = B.tmp();
    B.line(`${offset} = load i32, ptr ${offsetPtr}`);
    const stored = B.tmp();
    B.line(`${stored} = icmp sge i32 ${offset}, 0`);
    const read = B.newLabel("icr.read");
    B.condBr(stored, read, miss);
    B.startBlock(read);
    const native = load(host, "ptr", d, 16);
    const wide = B.tmp();
    B.line(`${wide} = sext i32 ${offset} to i64`);
    const fieldPtr = B.tmp();
    B.line(`${fieldPtr} = getelementptr inbounds i8, ptr ${native}, i64 ${wide}`);
    const cell = B.tmp();
    B.line(`${cell} = load ptr, ptr ${fieldPtr}`);
    incoming.push(`[ ${cell}, %${B.currentLabel()} ]`);
    B.br(join);
  }
}

function nativeArray(host: Host, d: string, no: string): string {
  const B = host.B;
  const capsule = B.newLabel("ica.cap");
  const bound = B.newLabel("ica.ops");
  const yes = B.newLabel("ica.arr");
  kindIs(host, d, DYN_KIND.TYPED_REF, capsule, no);
  B.startBlock(capsule);
  // The flag word after `casts`: record, klass and bag_class are its top
  // three bits; any of them means `array` holds other ops.
  const flags = load(host, "i32", d, 88);
  const kinds = B.tmp();
  const plain = B.tmp();
  B.line(`${kinds} = lshr i32 ${flags}, 29`);
  B.line(`${plain} = icmp eq i32 ${kinds}, 0`);
  B.condBr(plain, bound, no);
  B.startBlock(bound);
  const ops = load(host, "ptr", d, 64);
  const live = B.tmp();
  B.line(`${live} = icmp ne ptr ${ops}, null`);
  B.condBr(live, yes, no);
  B.startBlock(yes);
  return load(host, "ptr", d, 16);
}

/** `xs[i]` on a native number[] passed in from typed code: an integral
 * index below the array's hole-free prefix reads the element in place.
 * The other cases branch to `miss`, whose probe and helper answer them as
 * before. The result joins `incoming` at `join`. */
function emitNativeNumberElement(
  host: Host,
  receiver: string,
  e: IrExpr,
  indexIn: (next: string) => string,
  miss: string,
  join: string,
  incoming: string[],
): void {
  const B = host.B;
  const arr = nativeArray(host, receiver, miss);
  const numbers = B.newLabel("ica.f64");
  const elem = load(host, "i8", arr, 16);
  const f64 = B.tmp();
  B.line(`${f64} = icmp eq i8 ${elem}, 0 ; SCR_ELEM_F64`);
  B.condBr(f64, numbers, miss);
  B.startBlock(numbers);
  const index = indexIn(B.newLabel("ica.idx"));
  const filled = load(host, "i32", arr, 20);
  const filledD = B.tmp();
  const nonNegative = B.tmp();
  const below = B.tmp();
  const ok = B.tmp();
  B.line(`${filledD} = uitofp i32 ${filled} to double`);
  B.line(`${nonNegative} = fcmp oge double ${index}, 0.0`);
  B.line(`${below} = fcmp olt double ${index}, ${filledD}`);
  B.line(`${ok} = and i1 ${nonNegative}, ${below}`);
  const ranged = B.newLabel("ica.rng");
  B.condBr(ok, ranged, miss);
  B.startBlock(ranged);
  const i = B.tmp();
  const back = B.tmp();
  const integral = B.tmp();
  B.line(`${i} = fptoui double ${index} to i64`);
  B.line(`${back} = uitofp i64 ${i} to double`);
  B.line(`${integral} = fcmp oeq double ${back}, ${index}`);
  const hit = B.newLabel("ica.hit");
  B.condBr(integral, hit, miss);
  B.startBlock(hit);
  const data = load(host, "ptr", arr, 24);
  const slot = B.tmp();
  const value = B.tmp();
  B.line(`${slot} = getelementptr inbounds double, ptr ${data}, i64 ${i}`);
  B.line(`${value} = load double, ptr ${slot}`);
  let out: string;
  if (e.type.kind === "jsval") {
    const raw = B.tmp();
    const nan = B.tmp();
    const bits = B.tmp();
    out = B.tmp();
    B.line(`${raw} = bitcast double ${value} to i64`);
    B.line(`${nan} = fcmp uno double ${value}, ${value}`);
    B.line(`${bits} = select i1 ${nan}, i64 ${JS_BITS.canonicalNan}, i64 ${raw}`);
    B.line(`${out} = inttoptr i64 ${bits} to ptr`);
  } else {
    out = numberResult(host, value, e);
  }
  incoming.push(`[ ${out}, %${B.currentLabel()} ]`);
  B.br(join);
}

function emitKeyed(host: Host, e: ExprOf<"call">, callee: IrFunction): LlValue {
  const B = host.B;
  const receiver = emitBorrowedInput(host, e.args[0]!);
  const keyExpr = e.args[1]!;
  const numeric = numberKey(host, keyExpr);
  const key = numeric === null ? emitBorrowedInput(host, keyExpr) : null;
  const ic = host.jsIcSite();
  const array = B.newLabel("ick.arr");
  const number = B.newLabel("ick.num");
  const probe = B.newLabel("ick.probe");
  const slow = B.newLabel("ick.slow");
  const join = B.newLabel("ick.j");
  const incoming: string[] = [];
  // The boxed key of the miss paths when the site indexes with a double;
  // the statement's frame releases it.
  let keySlot: string | null = null;
  if (numeric !== null) {
    keySlot = B.slot();
    B.entryAllocas.push(`${keySlot} = alloca ptr`);
    B.line(`store ptr null, ptr ${keySlot}`);
    host.ownSlot(keySlot, DYN);
  }
  /** The key as a double in block `next`; other keys go to the probe. */
  const indexIn = (next: string): string => {
    if (numeric === null) {
      kindIs(host, key!.name, DYN_KIND.NUM, next, probe);
      B.startBlock(next);
      return load(host, "double", key!.name, 16);
    }
    B.condBr(numeric.present, next, probe);
    B.startBlock(next);
    return numeric.value;
  };
  const other = B.newLabel("ick.other");
  kindIs(host, receiver.name, DYN_KIND.ARR, array, other);
  B.startBlock(other);
  emitNativeNumberElement(host, receiver.name, e, indexIn, probe, join, incoming);
  B.startBlock(array);
  const index = indexIn(number);
  const len = load(host, "i64", receiver.name, 16);
  const i = B.tmp();
  const back = B.tmp();
  const integral = B.tmp();
  const inRange = B.tmp();
  const nonNegative = B.tmp();
  const ok1 = B.tmp();
  const ok2 = B.tmp();
  // fptoui of a negative or out-of-range double is poison: test the
  // double's range before trusting the integer.
  B.line(`${nonNegative} = fcmp oge double ${index}, 0.0`);
  const lenD = B.tmp();
  B.line(`${lenD} = uitofp i64 ${len} to double`);
  B.line(`${inRange} = fcmp olt double ${index}, ${lenD}`);
  B.line(`${ok1} = and i1 ${nonNegative}, ${inRange}`);
  const ranged = B.newLabel("ick.rng");
  B.condBr(ok1, ranged, probe);
  B.startBlock(ranged);
  B.line(`${i} = fptoui double ${index} to i64`);
  B.line(`${back} = uitofp i64 ${i} to double`);
  B.line(`${integral} = fcmp oeq double ${back}, ${index}`);
  const presence = load(host, "ptr", receiver.name, 56);
  const dense = B.tmp();
  B.line(`${dense} = icmp eq ptr ${presence}, null`);
  B.line(`${ok2} = and i1 ${integral}, ${dense}`);
  const hit = B.newLabel("ick.hit");
  B.condBr(ok2, hit, probe);
  B.startBlock(hit);
  const items = load(host, "ptr", receiver.name, 32);
  const itemPtr = B.tmp();
  B.line(`${itemPtr} = getelementptr inbounds ptr, ptr ${items}, i64 ${i}`);
  const item = B.tmp();
  B.line(`${item} = load ptr, ptr ${itemPtr}`);
  const itemEnd = B.currentLabel();
  const shared = B.newLabel("ick.shared");
  B.br(shared);
  B.startBlock(probe);
  let keyCell: string;
  if (numeric === null) {
    keyCell = key!.name;
  } else {
    keyCell = numeric.box();
    B.line(`store ptr ${keyCell}, ptr ${keySlot}`);
  }
  host.declare(`declare ptr @scr_js_keyed_probe(ptr, ptr, ptr)`);
  const probed = B.tmp();
  B.line(
    `${probed} = call ptr @scr_js_keyed_probe(ptr ${receiver.name}, ptr ${keyCell}, ptr ${ic})`,
  );
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${probed}, null`);
  const probeEnd = B.currentLabel();
  B.condBr(found, shared, slow);
  B.startBlock(shared);
  {
    const cell = B.tmp();
    const owned = B.tmp();
    B.line(`${cell} = phi ptr [ ${item}, %${itemEnd} ], [ ${probed}, %${probeEnd} ]`);
    B.line(`${owned} = phi i1 [ false, %${itemEnd} ], [ true, %${probeEnd} ]`);
    const out = asResult(host, cell, e, owned);
    incoming.push(`[ ${out}, %${B.currentLabel()} ]`);
  }
  B.br(join);
  B.startBlock(slow);
  const result = helperCall(host, e, callee, [receiver, { name: keyCell, type: DYN }]);
  incoming.push(`[ ${result}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi ptr ${incoming.join(", ")}`);
  return host.own({ name: out, type: e.type });
}

/** One member of an object literal (ir/js-ic.ts jsIcLiteralKey) added to
 * the fresh object `obj` through the site's store cache, else with
 * scr_dyn_key_set. The key and value are borrowed. */
export function emitJsIcLiteralMember(host: Host, obj: string, key: string, value: string): void {
  const B = host.B;
  const ic = host.jsIcSite();
  host.declare(`declare zeroext i1 @scr_js_store_probe(ptr, ptr, ptr, ptr)`);
  const done = B.tmp();
  B.line(
    `${done} = call zeroext i1 @scr_js_store_probe(ptr ${obj}, ptr ${key}, ptr ${value}, ptr ${ic})`,
  );
  const slow = B.newLabel("icl.slow");
  const join = B.newLabel("icl.j");
  B.condBr(done, join, slow);
  B.startBlock(slow);
  B.line(`call void @scr_dyn_key_set(ptr ${obj}, ptr ${key}, ptr ${value})`);
  host.emitPendingCheck();
  B.br(join);
  B.startBlock(join);
}

/** dynInvoke's method read on an ordinary object through the site's
 * cache, else scr_dyn_prepare_method. Returns the owned method (or NULL,
 * which scr_dyn_invoke_prepared_id answers with the full dispatch). */
export function emitJsIcMethod(host: Host, e: ExprOf<"dynInvoke">, receiver: string): string {
  const B = host.B;
  const method = e.method;
  const ic = host.jsIcSite();
  const name = keyString(host, method, e);
  host.declare(`declare ptr @scr_js_load_probe(ptr, ptr, ptr)`);
  host.declare(`declare ptr @scr_dyn_prepare_method(ptr, ptr)`);
  const object = B.newLabel("icm.obj");
  const probe = B.newLabel("icm.probe");
  const slow = B.newLabel("icm.slow");
  const join = B.newLabel("icm.j");
  const incoming: string[] = [];
  kindIs(host, receiver, DYN_KIND.OBJ, object, probe);
  B.startBlock(object);
  inlineLoad(
    host,
    receiver,
    ic,
    INLINE_WAYS,
    INLINE_PROTO,
    (cell) => host.retainFrame(cell, DYN),
    incoming,
    join,
    probe,
  );
  B.startBlock(probe);
  const probed = B.tmp();
  B.line(`${probed} = call ptr @scr_js_load_probe(ptr ${receiver}, ptr ${name}, ptr ${ic})`);
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${probed}, null`);
  incoming.push(`[ ${probed}, %${B.currentLabel()} ]`);
  B.condBr(found, join, slow);
  B.startBlock(slow);
  const prepared = B.tmp();
  B.line(
    `${prepared} = call ptr @scr_dyn_prepare_method(ptr ${receiver}, ptr ${host.cstr(method)}) cold`,
  );
  incoming.push(`[ ${prepared}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi ptr ${incoming.join(", ")}`);
  return out;
}
