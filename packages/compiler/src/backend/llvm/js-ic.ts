/* Inline-cache lowering of the dynamic tier (two-tier design stage S4;
 * runtime scr_js_object.c, sites ir/js-ic.ts).
 *
 * A property site in a dynamic-tier function owns one zeroed thread-local
 * ScrJsIc record (`@sc_js_ic_N`). The code at the site is fixed:
 *
 *   load   ordinary object whose layout is entry 0's own-property layout:
 *          read slot `slot` inline; otherwise scr_js_get_probe
 *          (polymorphic, prototype hits, absent keys, misses)
 *   store  ordinary object whose layout is entry 0's replace layout,
 *          outside an intact parse region: replace inline; otherwise
 *          scr_js_store_probe (adds, polymorphic, misses)
 *   keyed  dense array element at an integral number key: inline;
 *          otherwise scr_js_keyed_probe (string keys of ordinary objects)
 *   method dynInvoke's method read: scr_js_load_probe
 *   call   a method dispatch helper's call: a capsule whose key is one of
 *          the helper's plain class branches calls that branch's method
 *          directly (capsuleCallSite); otherwise the helper
 *   literal an object literal's constant-key member: scr_js_store_probe,
 *          else scr_dyn_key_set
 *
 * A probe that cannot answer from plain data leaves everything untouched,
 * and the site calls its helper (or the generic runtime entry), which
 * defines the operation's semantics; nothing is ever patched.
 *
 * Layout facts (64-bit only; 32-bit targets keep the helper calls):
 *   ScrDyn       kind +8; v.obj {len +16, slots +32, region +72,
 *                layout +80}; v.arr {len +16, items +32, presence +56};
 *                v.num +16. Every property of an object with a layout is
 *                a writable data property (scr_dyn.h's layout mode);
 *                dictionary-mode objects have a null layout.
 *                v.typed_ref {ptr +16, type_key +40}.
 *   ScrJsIc      entries of 40 bytes {layout, target, holder,
 *                holder_layout, slot}; 168 bytes in all */
import { BOOL, DYN, F64, STRING, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { jsIcMethodSites, type JsIcSite } from "../../ir/js-ic.js";
import { jsObjectModelFact } from "../../ir/runtime-features.js";
import { mangleBorrowedFunction } from "../mangle.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";
import { classFieldBase, classFieldIndex } from "./classes.js";
import { DYN_KIND } from "./dyn.js";
import { dispatchesCall } from "./integer-clones.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { JS_BITS } from "./jsval-encoding.js";
import { jsImmediates } from "./jsval.js";

type Host = LlvmEmitterContext;

/** Words of one ScrJsIc record. */
export const JS_IC_WORDS = 21;

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
    jsIcMethodSites(host.currentFunctionName, host.loopDepth > 0)
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

/** The offset of an array's own length in its ScrDyn payload: the
 * JavaScript object model build keeps `v.arr.length` one field past
 * `v.arr.region` (+72), because a far element write or a length assignment
 * can move it past the dense prefix `v.arr.len` (+16). A program that does
 * not link that build reads the prefix field, which is then the length. */
function arrLengthOffset(host: Host): number {
  return jsObjectModelFact(host.runtimeFeatures) ? 72 : 16;
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
 * Two entries cover the common two-layout site (object literals of one
 * record built in two key orders): on bench:runtime's dynamic-properties
 * they made the run 13% faster than one entry, and 26% faster without its
 * class instances; four were no faster than two. So a site tests entries
 * 0 and 1, own or prototype, and its probe does the rest. (0 makes every access probe: with a runtime
 * built with SCR_JS_VERIFY, that probes every access.)
 *
 * SCRIPTC_DEBUG_JS_IC_WAYS=0|1|2 overrides the count for an attribution run,
 * where every access should reach the probe so that the runtime entry points
 * can count it; the value is read once, so one build is one way count. */
/** The attribution way count `SCRIPTC_DEBUG_JS_IC_WAYS` asks for, or null
 * when the variable is unset. The value changes emitted code, so the build
 * cache keys on it (executable/executable-cache.ts). */
export function debugJsIcWays(env: NodeJS.ProcessEnv = process.env): 0 | 1 | 2 | null {
  const raw = env["SCRIPTC_DEBUG_JS_IC_WAYS"];
  if (raw === undefined || raw === "") return null;
  const ways = Number(raw);
  if (ways !== 0 && ways !== 1 && ways !== 2)
    throw new Error(`SCRIPTC_DEBUG_JS_IC_WAYS must be 0, 1 or 2, got ${raw}`);
  return ways;
}

const IC_WAYS_DEBUG: 0 | 1 | 2 | null = debugJsIcWays();
const INLINE_WAYS: number = IC_WAYS_DEBUG ?? 2;

/* An attribution run gives an object literal's member stores their own probe
 * entry point, so a profile can split them from other stores. With the
 * variable unset the emitted code calls scr_js_store_probe as before. */
const LITERAL_PROBE: string =
  IC_WAYS_DEBUG === null ? "scr_js_store_probe" : "scr_js_literal_probe";
const INLINE_PROTO = true;

/** The address of slot `slot` of layout-mode object `d`. */
function slotAt(host: Host, d: string, slot: string): string {
  const B = host.B;
  const slots = load(host, "ptr", d, 32);
  const address = B.tmp();
  B.line(`${address} = getelementptr inbounds ptr, ptr ${slots}, i64 ${slot}`);
  return address;
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
  const shape = load(host, "ptr", d, 80); // v.obj.layout
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
      const value = load(host, "ptr", slotAt(host, holder, slot), 0);
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
 * address of the property's slot, which must end its block by
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
  const shape = load(host, "ptr", d, 80); // v.obj.layout
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
    store(slotAt(host, d, slot));
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

/** A class instance's answer that a read helper gives by loading one
 * declared field: the branch `if (dyn.typedRefIs(p, KEY)) { r =
 * dynCheck(p); return [js.fromDyn](fieldGet C.f(r)) }`. */
interface CapsuleRead {
  key: string;
  className: string;
  field: string;
}

/** The class branches of a read helper that a site can answer inline for
 * capsules (class instances boxed as dyn values), or none.
 *
 * The helper first normalizes its receiver (`%dyn.class.normalize`
 * reboxes a capsule keyed with a base class whose instance belongs to a
 * subclass), then tests each class branch in turn. The site loads the
 * field of a capsule whose key is a branch's key without normalizing, so
 * a branch qualifies only when every subclass the normalization can
 * rebox its key to has a branch that loads the same field from the same
 * slot of a layout that extends the class's. Every other capsule, and
 * every helper or normalization of another form, keeps the helper. */
function capsuleReads(host: Host, helper: IrFunction): CapsuleRead[] {
  const receiver = helper.params[0]?.localId;
  if (receiver === undefined || helper.params.length !== 1) return [];
  const reads = new Map<string, CapsuleRead | null>();
  for (const stmt of tableBranches(helper.body)) {
    if (normalizes(stmt, receiver)) continue;
    if (stmt.kind !== "if" || stmt.else_ !== null) break;
    if (notCapsule(stmt.cond, receiver)) continue;
    const key = brandKey(stmt.cond, receiver);
    if (key === null) return [];
    if (!reads.has(key)) reads.set(key, capsuleRead(stmt, receiver, key));
  }
  const reboxes = normalizationTargets(host);
  if (reboxes === null) return [];
  const out: CapsuleRead[] = [];
  for (const read of reads.values()) {
    if (read === null || !plainField(host, read.className, read.field)) continue;
    const targets = reboxes.get(read.key) ?? [];
    const same = targets.every((target) => {
      const other = reads.get(`object:${target}`);
      return (
        other != null &&
        other.field === read.field &&
        plainField(host, target, read.field) &&
        extendsLayout(host, target, read.className, read.field)
      );
    });
    if (same) out.push(read);
  }
  return out;
}

/** A class table's branches in the order a receiver that matches none of
 * them reaches their guards: the statements of the body, with a
 * `dyn.classHash` switch replaced by its cases' branches. A capsule whose
 * key is a branch's selects that case, whose guard is then true, so the
 * site can treat the branches as the chain they were lowered from. */
function tableBranches(body: readonly IrStmt[]): readonly IrStmt[] {
  if (!body.some(isClassHashSwitch)) return body;
  const branches: IrStmt[] = [];
  for (const stmt of body) {
    if (isClassHashSwitch(stmt))
      for (const { body: caseBody } of stmt.cases) branches.push(...caseBody);
    else branches.push(stmt);
  }
  return branches;
}

/** The switch the compiler builds over a generated class table's branches
 * (frontend/lowering/class-dynamic-dispatch.ts). */
function isClassHashSwitch(stmt: IrStmt): stmt is IrStmt & { kind: "switch" } {
  return stmt.kind === "switch" && stmt.disc.kind === "libCall" && stmt.disc.fn === "dyn.classHash";
}

/** `p = %dyn.class.normalize(p)`. */
function normalizes(stmt: IrStmt, receiver: string): boolean {
  return (
    stmt.kind === "assign" &&
    stmt.localId === receiver &&
    stmt.value.kind === "call" &&
    stmt.value.callee === "%dyn.class.normalize" &&
    stmt.value.args.length === 1 &&
    isLocal(stmt.value.args[0]!, receiver)
  );
}

/** `!classCapsule(p)`: false for every capsule of a compiled class, so a
 * capsule never enters the branch it guards. */
function notCapsule(cond: IrExpr, receiver: string): boolean {
  return (
    cond.kind === "dynTest" &&
    cond.test === "classCapsule" &&
    cond.negated === true &&
    isLocal(cond.value, receiver)
  );
}

function isLocal(e: IrExpr, id: string): boolean {
  return e.kind === "varRef" && e.localId === id;
}

/** The capsule key `dyn.typedRefIs(p, "object:C")` tests, or null. */
function brandKey(cond: IrExpr, receiver: string): string | null {
  if (cond.kind !== "libCall" || cond.fn !== "dyn.typedRefIs" || cond.args.length !== 2)
    return null;
  const [value, key] = cond.args;
  if (!isLocal(value!, receiver) || key?.kind !== "strLit" || !key.value.startsWith("object:"))
    return null;
  return key.value;
}

/** The field a class branch loads, or null for a branch of another form. */
function capsuleRead(
  branch: IrStmt & { kind: "if" },
  receiver: string,
  key: string,
): CapsuleRead | null {
  const [decl, ret] = branch.then;
  if (branch.then.length !== 2 || decl?.kind !== "varDecl" || ret?.kind !== "return") return null;
  if (decl.init?.kind !== "dynCheck" || !isLocal(decl.init.value, receiver)) return null;
  let value = ret.value;
  if (value?.kind === "libCall" && value.fn === "js.fromDyn" && value.args.length === 1)
    value = value.args[0]!;
  if (value?.kind !== "fieldGet" || !isLocal(value.obj, decl.localId)) return null;
  if (key !== `object:${value.className}`) return null;
  return { key, className: value.className, field: value.field };
}

/** For each capsule key `%dyn.class.normalize` reboxes, the classes it
 * may rebox to; null when the normalization has another form. */
function normalizationTargets(host: Host): Map<string, string[]> | null {
  const targets = new Map<string, string[]>();
  const normalize = host.fnByName.get("%dyn.class.normalize");
  if (normalize === undefined) return targets;
  const value = normalize.params[0]?.localId;
  if (value === undefined) return null;
  for (const stmt of tableBranches(normalize.body)) {
    if (stmt.kind === "return") {
      if (stmt.value !== null && isLocal(stmt.value, value)) continue;
      return null;
    }
    if (stmt.kind !== "if" || stmt.else_ !== null) return null;
    if (notCapsule(stmt.cond, value)) continue;
    const key = brandKey(stmt.cond, value);
    if (key === null) return null;
    const [decl, ...checks] = stmt.then;
    if (decl?.kind !== "varDecl" || decl.init?.kind !== "dynCheck") return null;
    const into = targets.get(key) ?? [];
    for (const check of checks) {
      if (
        check.kind !== "if" ||
        check.else_ !== null ||
        check.cond.kind !== "instanceOf" ||
        !isLocal(check.cond.value, decl.localId)
      )
        return null;
      into.push(check.cond.className);
    }
    targets.set(key, into);
  }
  return targets;
}

/** A declared field of a compiled class that holds a plain dyn cell
 * pointer: not compact, compressed, int32 or an inline union. */
function plainField(host: Host, className: string, field: string): boolean {
  const meta = host.classMeta.get(className);
  if (meta === undefined || meta.compact) return false;
  const decl = meta.def.fields.find((f) => f.name === field);
  if (decl === undefined || decl.type.kind !== "dyn") return false;
  if (classFieldIndex(meta, field, "compressed").compressed) return false;
  return (
    !host.int32Slots.isField(className, field) && !host.inlineUnions.classField(className, field)
  );
}

/** Whether `sub`'s layout starts with `base`'s through `field`: the same
 * header and the same fields in the same slots, so a load through
 * `base`'s struct reads `sub`'s field. */
function extendsLayout(host: Host, sub: string, base: string, field: string): boolean {
  const a = host.classMeta.get(base);
  const b = host.classMeta.get(sub);
  if (a === undefined || b === undefined || b.compact) return false;
  if (classFieldBase(a) !== classFieldBase(b)) return false;
  const end = a.def.fields.findIndex((f) => f.name === field);
  if (end < 0 || end >= b.def.fields.length) return false;
  for (let i = 0; i <= end; i++) {
    const x = a.def.fields[i]!;
    const y = b.def.fields[i]!;
    if (x.name !== y.name || x.type.kind !== y.type.kind) return false;
  }
  return (
    classFieldIndex(a, field, "compressed").index === classFieldIndex(b, field, "compressed").index
  );
}

/** The inline part of a read site for a capsule `d`: a capsule whose key
 * is one of `reads`' keys answers with the (borrowed) field cell, branching
 * to `join` and recording its phi input; anything else, including a field
 * not yet set, branches to `miss`. */
function inlineCapsuleLoad(
  host: Host,
  d: string,
  reads: readonly CapsuleRead[],
  incoming: string[],
  join: string,
  miss: string,
): void {
  const B = host.B;
  const capsule = B.newLabel("icc.cap");
  kindIs(host, d, DYN_KIND.TYPED_REF, capsule, miss);
  B.startBlock(capsule);
  // Capsules boxed by this program share its key constants.
  const key = load(host, "ptr", d, 40);
  let next = B.newLabel("icc.k");
  B.br(next);
  reads.forEach((read, i) => {
    B.startBlock(next);
    next = i + 1 < reads.length ? B.newLabel("icc.k") : miss;
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${key}, ${host.cstr(read.key)}`);
    const matched = B.newLabel("icc.m");
    B.condBr(same, matched, next);
    B.startBlock(matched);
    const instance = load(host, "ptr", d, 16);
    const { ptr } = host.classFieldPtr(instance, read.className, read.field);
    const cell = B.tmp();
    B.line(`${cell} = load ptr, ptr ${ptr}`);
    const set = B.tmp();
    B.line(`${set} = icmp ne ptr ${cell}, null`);
    const hit = B.newLabel("icc.hit");
    B.condBr(set, hit, miss);
    B.startBlock(hit);
    incoming.push(`[ ${cell}, %${B.currentLabel()} ]`);
    B.br(join);
  });
}

/** A class instance's answer that a method dispatch helper gives by
 * calling one compiled method: the branch `if (dyn.typedRefIs(p, KEY)) {
 * M(R, p1, ..., pn); return [js.fromDyn](p) }` of a method that returns
 * its receiver, or `{ return [js.fromDyn](M(R, p1, ..., pn)) }`, with R
 * `dynCheck(p)` or an upcast of it. */
interface CapsuleCall {
  key: string;
  className: string;
  method: string;
  /** The branch returns the receiver after the call. */
  returnsReceiver: boolean;
}

/** A call of a method dispatch helper `%dyn.class.call.N(receiver,
 * %dyn.class.callback.N(receiver), args..., calleeName)` whose class
 * branches a site can call inline. */
export interface CapsuleCallSite {
  callback: IrFunction;
  calls: CapsuleCall[];
}

/** The capsule call site a call from dynamic-tier code is, or null.
 *
 * The helper normalizes its receiver like a read helper, then tests each
 * class branch; the callback the site calls before evaluating the
 * arguments resolves own function-valued properties of bag classes. A
 * capsule whose key is a branch's key calls the branch's method directly
 * when the branch qualifies under capsuleReads' rule (every subclass the
 * normalization can rebox the key to has a branch calling the same
 * method) and the callback has no branch for the key or any of those
 * subclasses, so it answers undefined for the capsule without effects.
 * Module initializers call this way only inside loops (jsIcMethodSites). */
export function capsuleCallSite(
  host: Host,
  e: ExprOf<"call">,
  helper: IrFunction,
): CapsuleCallSite | null {
  if (!jsIcMethods(host) || !helper.name.startsWith("%dyn.class.call.")) return null;
  if (helper.async !== undefined || helper.generator !== undefined) return null;
  if (e.type.kind !== "jsval" && e.type.kind !== "dyn") return null;
  const { params } = helper;
  const arity = params.length - 3;
  if (
    arity < 0 ||
    e.args.length !== params.length ||
    params[1]!.localId !== "p.callback" ||
    params[params.length - 1]!.localId !== "p.calleeName" ||
    params.slice(2, -1).some((p, i) => p.localId !== `p.${i + 1}`)
  )
    return null;
  const [receiver, resolve] = e.args;
  if (
    receiver?.kind !== "varRef" ||
    resolve?.kind !== "call" ||
    resolve.args.length !== 1 ||
    !isLocal(resolve.args[0]!, receiver.localId)
  )
    return null;
  const callback = host.fnByName.get(resolve.callee);
  if (callback === undefined || callback.params.length !== 1) return null;
  const resolved = callbackKeys(callback);
  if (resolved === null) return null;
  const branches = new Map<string, CapsuleCall | null>();
  const self = params[0]!.localId;
  for (const stmt of tableBranches(helper.body)) {
    if (normalizes(stmt, self)) continue;
    if (stmt.kind !== "if" || stmt.else_ !== null) break;
    if (notCapsule(stmt.cond, self) || classObjectTest(stmt.cond, self)) continue;
    const key = brandKey(stmt.cond, self);
    if (key === null) return null;
    if (!branches.has(key)) branches.set(key, capsuleCall(host, stmt, self, key, arity));
  }
  const reboxes = normalizationTargets(host);
  if (reboxes === null) return null;
  const calls: CapsuleCall[] = [];
  for (const call of branches.values()) {
    if (call === null) continue;
    const targets = reboxes.get(call.key) ?? [];
    if (resolved.has(call.key) || targets.some((t) => resolved.has(`object:${t}`))) continue;
    const same = targets.every((target) => {
      const other = branches.get(`object:${target}`);
      return (
        other != null &&
        other.method === call.method &&
        other.returnsReceiver === call.returnsReceiver
      );
    });
    if (same) calls.push(call);
  }
  return calls.length > 0 ? { callback, calls } : null;
}

/** The capsule keys a dispatch callback has branches for, or null when
 * its body has another form: the normalization, branches on capsule or
 * class-object tests, and a final return of undefined. */
function callbackKeys(callback: IrFunction): Set<string> | null {
  const value = callback.params[0]!.localId;
  const keys = new Set<string>();
  const body = tableBranches(callback.body);
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i]!;
    if (normalizes(stmt, value)) continue;
    if (stmt.kind === "if" && stmt.else_ === null) {
      if (notCapsule(stmt.cond, value) || classObjectTest(stmt.cond, value)) continue;
      const key = brandKey(stmt.cond, value);
      if (key === null) return null;
      keys.add(key);
      continue;
    }
    if (i === body.length - 1 && stmt.kind === "return" && returnsUndefined(stmt.value))
      return keys;
    return null;
  }
  return null;
}

/** `dyn.classIs(p, "classval:C")`: true only for a class object, never
 * for a capsule. */
function classObjectTest(cond: IrExpr, receiver: string): boolean {
  return (
    cond.kind === "libCall" &&
    cond.fn === "dyn.classIs" &&
    cond.args.length === 2 &&
    isLocal(cond.args[0]!, receiver)
  );
}

function returnsUndefined(value: IrExpr | null): boolean {
  if (value?.kind === "libCall" && value.fn === "js.fromDyn" && value.args.length === 1)
    value = value.args[0]!;
  return (
    value?.kind === "dynFrom" && value.value.kind === "unitLit" && value.value.unit === "undefined"
  );
}

/** The method a class branch calls, or null for a branch of another
 * form. */
function capsuleCall(
  host: Host,
  branch: IrStmt & { kind: "if" },
  receiver: string,
  key: string,
  arity: number,
): CapsuleCall | null {
  const [first, second] = branch.then;
  let call: IrExpr | null | undefined;
  let returnsReceiver: boolean;
  if (branch.then.length === 2 && first?.kind === "exprStmt" && second?.kind === "return") {
    call = first.expr;
    let value = second.value;
    if (value?.kind === "libCall" && value.fn === "js.fromDyn" && value.args.length === 1)
      value = value.args[0]!;
    if (value === null || !isLocal(value, receiver) || call.type.kind !== "void") return null;
    returnsReceiver = true;
  } else if (branch.then.length === 1 && first?.kind === "return") {
    call = first.value;
    if (call?.kind === "libCall" && call.fn === "js.fromDyn" && call.args.length === 1)
      call = call.args[0]!;
    returnsReceiver = false;
  } else return null;
  if (call?.kind !== "call" || call.args.length !== arity + 1) return null;
  let self = call.args[0]!;
  if (self.kind === "upcast") self = self.value;
  if (self.kind !== "dynCheck" || !isLocal(self.value, receiver) || self.type.kind !== "object")
    return null;
  if (key !== `object:${self.type.className}`) return null;
  if (!call.args.slice(1).every((a, i) => isLocal(a, `p.${i + 1}`))) return null;
  if (!plainMethod(host, call.callee, returnsReceiver)) return null;
  return { key, className: self.type.className, method: call.callee, returnsReceiver };
}

/** A method the site can call with the ordinary or borrowed ABI and a
 * dyn, jsval or void result. */
function plainMethod(host: Host, name: string, returnsReceiver: boolean): boolean {
  const fn = host.fnByName.get(name);
  if (fn === undefined || fn.async !== undefined || fn.generator !== undefined) return false;
  if (fn.captures !== undefined) return false;
  if (host.int32Abis.has(name)) return false;
  if (dispatchesCall(host.integerClones, host.currentFunctionName, name)) return false;
  const result = fn.returnType.kind;
  return returnsReceiver ? result === "void" : result === "dyn" || result === "jsval";
}

/** A call of a method dispatch helper from dynamic-tier code whose class
 * branches qualify (capsuleCallSite). A capsule with one of their keys
 * skips the callback (it answers undefined for it) and calls the
 * branch's method with the capsule's instance; anything else calls the
 * callback before the arguments and then the helper, as the plain call
 * does. The arguments are evaluated once, after the callback. */
export function emitCapsuleCall(
  host: Host,
  e: ExprOf<"call">,
  helper: IrFunction,
  site: CapsuleCallSite,
): LlValue {
  const B = host.B;
  const receiver = emitBorrowedInput(host, e.args[0]!);
  const capsule = B.newLabel("iccall.cap");
  const resolve = B.newLabel("iccall.cb");
  const evaluate = B.newLabel("iccall.args");
  const matched = site.calls.map(() => B.newLabel("iccall.k"));
  kindIs(host, receiver.name, DYN_KIND.TYPED_REF, capsule, resolve);
  B.startBlock(capsule);
  // Capsules boxed by this program share its key constants.
  const key = load(host, "ptr", receiver.name, 40);
  site.calls.forEach((call, i) => {
    const same = B.tmp();
    B.line(`${same} = icmp eq ptr ${key}, ${host.cstr(call.key)}`);
    const next = i + 1 < site.calls.length ? B.newLabel("iccall.t") : resolve;
    B.condBr(same, matched[i]!, next);
    if (next !== resolve) B.startBlock(next);
  });
  for (const label of matched) {
    B.startBlock(label);
    B.br(evaluate);
  }
  B.startBlock(resolve);
  const resolved = helperCall(host, e.args[1] as ExprOf<"call">, site.callback, [receiver]);
  const resolveEnd = B.currentLabel();
  B.br(evaluate);
  B.startBlock(evaluate);
  // The branch a capsule takes, or -1 for the helper.
  const branch = B.tmp();
  const branches = matched.map((label, i) => `[ ${i}, %${label} ]`);
  B.line(`${branch} = phi i32 ${[...branches, `[ -1, %${resolveEnd} ]`].join(", ")}`);
  // The callback's result for an inline capsule is never read: undefined
  // for a jsval result, null for a dyn one.
  const unread =
    site.callback.returnType.kind === "jsval"
      ? `inttoptr (i64 ${JS_BITS.undefined} to ptr)`
      : "null";
  const cb = B.tmp();
  const cbIn = matched.map((label) => `[ ${unread}, %${label} ]`);
  B.line(`${cb} = phi ptr ${[...cbIn, `[ ${resolved}, %${resolveEnd} ]`].join(", ")}`);
  host.own({ name: cb, type: site.callback.returnType });
  const rest = e.args.slice(2).map((a) => emitBorrowedInput(host, a));
  const slow = B.newLabel("iccall.slow");
  const join = B.newLabel("iccall.j");
  const calls = site.calls.map(() => B.newLabel("iccall.m"));
  const cases = calls.map((label, i) => `i32 ${i}, label %${label}`).join(" ");
  B.terminate(`switch i32 ${branch}, label %${slow} [ ${cases} ]`);
  const incoming: string[] = [];
  site.calls.forEach((call, i) => {
    B.startBlock(calls[i]!);
    const instance = load(host, "ptr", receiver.name, 16);
    const self: LlValue = { name: instance, type: { kind: "object", className: call.className } };
    const result = methodCall(host, call.method, [self, ...rest.slice(0, -1)]);
    let out: string;
    if (call.returnsReceiver) {
      const held = host.retainFrame(receiver.name, DYN);
      out = e.type.kind === "jsval" ? cellWord(host, held) : held;
    } else {
      const returned = host.fnByName.get(call.method)!.returnType;
      out = returned.kind === e.type.kind ? result : asResult(host, result, e, true);
    }
    incoming.push(`[ ${out}, %${B.currentLabel()} ]`);
    B.br(join);
  });
  B.startBlock(slow);
  const result = helperCall(host, e, helper, [
    receiver,
    { name: cb, type: site.callback.returnType },
    ...rest,
  ]);
  incoming.push(`[ ${result}, %${B.currentLabel()} ]`);
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi ptr ${incoming.join(", ")}`);
  return host.own({ name: out, type: e.type });
}

/** A held cell as a jsval word. */
function cellWord(host: Host, cell: string): string {
  const B = host.B;
  const bits = B.tmp();
  const word = B.tmp();
  const tagged = B.tmp();
  B.line(`${bits} = ptrtoint ptr ${cell} to i64`);
  B.line(`${word} = or i64 ${bits}, ${JS_BITS.cellTag}`);
  B.line(`${tagged} = inttoptr i64 ${word} to ptr`);
  return tagged;
}

/** A direct call of a compiled method with the site's evaluated
 * (borrowed) arguments, as helperCall passes them. Returns the owned
 * result, or "" for a void method. */
function methodCall(host: Host, name: string, args: LlValue[]): string {
  const B = host.B;
  const method = host.fnByName.get(name)!;
  const borrowed = host.callLifetimes.borrowed.get(name);
  const argList = args
    .map((a, i) => {
      const type = method.params[i]!.type;
      const value = borrowed?.has(i) ? a.name : host.retainFrame(a.name, type);
      return `${host.llType(type)} ${value}`;
    })
    .join(", ");
  const target = `@${borrowed ? mangleBorrowedFunction(name) : host.callTarget(name)}`;
  if (method.returnType.kind === "void") {
    const invoked = host.emitDirectCall(`call void ${target}(${argList})`, name);
    if (!invoked && host.mayThrow.has(name)) host.emitPendingCheck();
    return "";
  }
  let t = B.tmp();
  const invoked = host.emitDirectCall(
    `${t} = call ${host.llType(method.returnType)} ${target}(${argList})`,
    name,
  );
  if (!invoked && host.mayThrow.has(name)) host.emitPendingCheck();
  if (borrowed && host.borrowedReturns.has(name)) t = host.retainFrame(t, method.returnType);
  return t;
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
  }
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
    const len = load(host, "i64", receiver.name, arrLengthOffset(host));
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
  // Inline hits (borrowed values) and probe hits (owned ones) share one
  // conversion to the result type.
  const hit = B.newLabel("icg.hit");
  const hits: string[] = [];
  const reads = capsuleReads(host, callee);
  const other = reads.length > 0 ? B.newLabel("icg.other") : probe;
  kindIs(host, receiver.name, DYN_KIND.OBJ, object, other);
  B.startBlock(object);
  inlineLoad(host, receiver.name, ic, INLINE_WAYS, INLINE_PROTO, (cell) => cell, hits, hit, probe);
  if (reads.length > 0) {
    B.startBlock(other);
    inlineCapsuleLoad(host, receiver.name, reads, hits, hit, probe);
  }
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
  host.declare(`declare zeroext i1 @${LITERAL_PROBE}(ptr, ptr, ptr, ptr)`);
  const done = B.tmp();
  B.line(
    `${done} = call zeroext i1 @${LITERAL_PROBE}(ptr ${obj}, ptr ${key}, ptr ${value}, ptr ${ic})`,
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
