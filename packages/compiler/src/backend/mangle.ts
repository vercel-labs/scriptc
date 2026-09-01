/* Name mangling. Distinct prefixes partition the C namespace:
 *   sc_f_  user functions        sc_l_  locals
 *   sc_t   emitter temporaries   sc_lit_ interned string literals
 *   scr_/Scr* runtime
 * so no denylist of C keywords or library names is needed.
 *
 * TS identifiers may contain characters C identifiers cannot ($, unicode);
 * those are encoded as _xHH..._ (hex code point) so distinct TS names can
 * never collide after mangling. '.' (from scope-flat local ids like "x.1")
 * maps to '_' — ids differing only by '.'/'_' cannot both come from the
 * frontend, which separates name and counter with '.' exclusively.
 */

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, (ch) =>
    ch === "." ? "_" : `_x${ch.codePointAt(0)!.toString(16)}_`,
  );
}

export function mangleFunction(name: string): string {
  return `sc_f_${sanitize(name)}`;
}

export function mangleLocal(localId: string): string {
  return `sc_l_${sanitize(localId)}`;
}

/** Raw incoming value of a boxed parameter (the box itself takes the
 * sc_l_ name so every access goes through it). */
export function mangleRawParam(localId: string): string {
  return `sc_p_${sanitize(localId)}`;
}

/** Env-signature wrapper letting a plain declared function be a closure. */
export function mangleWrapper(fnName: string): string {
  return `sc_w_${sanitize(fnName)}`;
}

/** The interned (immortal) closure value of a declared function. */
export function mangleFnClosure(fnName: string): string {
  return `sc_fc_${sanitize(fnName)}`;
}

/** Per-class emitted C struct and RC helpers. */
export function mangleClassStruct(className: string): string {
  return `sc_o_${sanitize(className)}`;
}
/** The immortal class OBJECT static (classes as first-class values). */
export function mangleClassObj(className: string): string {
  return `sc_co_${sanitize(className)}`;
}
/** The construct thunk a class object's `ctor` slot points at. */
export function mangleCtorThunk(className: string): string {
  return `sc_ct_${sanitize(className)}`;
}
export function mangleClassNew(className: string): string {
  return `sc_new_${sanitize(className)}`;
}
export function mangleClassRetain(className: string): string {
  return `sc_retain_${sanitize(className)}`;
}
export function mangleClassRelease(className: string): string {
  return `sc_release_${sanitize(className)}`;
}
export function mangleField(fieldName: string): string {
  return `sc_fld_${sanitize(fieldName)}`;
}
/** Hierarchy classes only (an `extends` anywhere): the per-class DIRECT
 * release — the whole-object teardown stored in the class's vtable, which
 * the public release reaches through the DYNAMIC object's vt pointer so a
 * base-typed release tears down the derived object's fields. */
export function mangleClassReleaseDirect(className: string): string {
  return `sc_reld_${sanitize(className)}`;
}
/** The per-HIERARCHY vtable struct type (named after the root class): a
 * ScrVt head plus one member per virtual method slot. */
export function mangleVtStruct(rootClassName: string): string {
  return `sc_vtt_${sanitize(rootClassName)}`;
}
/** The per-class static vtable instance. `sc_vtable_` and `sc_vtt_`
 * differ before any user-controlled text, so the two can never collide. */
export function mangleVtInstance(className: string): string {
  return `sc_vtable_${sanitize(className)}`;
}
/** A virtual slot's member name inside the vtable struct. Sibling
 * branches of one hierarchy can each declare a slot for the SAME method
 * name (root-most in their own subtree, overridden below — mixin layers
 * make this routine): occurrence 0 keeps the historical spelling, later
 * occurrences take an ordinal after `sc_vs` — a method name cannot begin
 * with a digit, so the two spellings never collide. */
export function mangleVtSlot(method: string, occurrence = 0): string {
  return occurrence === 0 ? `sc_vs_${sanitize(method)}` : `sc_vs${occurrence}_${sanitize(method)}`;
}
/** The adapter stored in a vtable slot: the implementing class's method
 * behind the slot's declaring-class `this` signature (the reinterpret that
 * prefix layout makes sound). */
export function mangleVtAdapter(className: string, method: string): string {
  return `sc_vm_${sanitize(`${className}.${method}`)}`;
}
/** Cycle-collector entry points of a cycle-capable class: the trace
 * (enumerates cycle-capable fields) and the teardown (frees without
 * releasing traced fields) stored in the object's cycle header. */
export function mangleClassTrace(className: string): string {
  return `sc_trace_${sanitize(className)}`;
}
export function mangleClassGcFree(className: string): string {
  return `sc_gcfree_${sanitize(className)}`;
}

/** Per-record-shape emitted C struct and RC helpers. Shape ids are
 * compiler-generated (`r0`, `r1`, ...), but the prefixes are still disjoint
 * from every class prefix above (sc_rs_X vs sc_o_Y, sc_rnew_X vs
 * sc_new_Y, ...) so no user class name can collide with a record symbol. */
export function mangleRecordStruct(shapeId: string): string {
  return `sc_rs_${sanitize(shapeId)}`;
}
export function mangleRecordNew(shapeId: string): string {
  return `sc_rnew_${sanitize(shapeId)}`;
}
export function mangleRecordClone(shapeId: string): string {
  return `sc_rclone_${sanitize(shapeId)}`;
}
export function mangleRecordRetain(shapeId: string): string {
  return `sc_rretain_${sanitize(shapeId)}`;
}
export function mangleRecordRelease(shapeId: string): string {
  return `sc_rrelease_${sanitize(shapeId)}`;
}
/** Cycle-collector entry points of a cycle-capable record shape (mirrors
 * the class pair above; prefixes stay disjoint from class symbols). */
export function mangleRecordTrace(shapeId: string): string {
  return `sc_rtrace_${sanitize(shapeId)}`;
}
export function mangleRecordGcFree(shapeId: string): string {
  return `sc_rgcfree_${sanitize(shapeId)}`;
}

/** Module-level variable ("%g.e.count" → "sc_g_e_count"). The id's tag
 * segment ("e."/"m<i>.") plus dot-free user identifiers make this injective. */
export function mangleGlobal(globalId: string): string {
  return `sc_g_${sanitize(globalId.replace(/^%g\./, ""))}`;
}

/** Async function machinery: spawn wrapper, trampoline, argument pack. */
export function mangleAsyncSpawn(fnName: string): string {
  return `sc_as_${sanitize(fnName)}`;
}
export function mangleTrampoline(fnName: string): string {
  return `sc_tr_${sanitize(fnName)}`;
}
export function mangleArgPack(fnName: string): string {
  return `sc_ap_${sanitize(fnName)}`;
}
/** Generator function machinery: spawn wrapper (allocates the suspended
 * fiber — nothing runs) and the never-started argpack drop. The pack and
 * trampoline manglers are shared with async (a function is one or the
 * other, never both). */
export function mangleGenSpawn(fnName: string): string {
  return `sc_gs_${sanitize(fnName)}`;
}
export function mangleGenDrop(fnName: string): string {
  return `sc_gd_${sanitize(fnName)}`;
}
/** Emitted ref-kind resolve thunk, interned per inner-type key. */
export function mangleResolveThunk(n: number): string {
  return `sc_rslv_${n}`;
}
/** Emitted generator-resume result builder (the IteratorResult record),
 * interned per generator-type key. */
export function mangleGenResThunk(n: number): string {
  return `sc_gres_${n}`;
}
/** Emitted Promise.race fulfillment adapter (entry inner type → result
 * inner type), interned per type pair. */
export function mangleRaceThunk(n: number): string {
  return `sc_race_${n}`;
}
/** Generated Promise.all tuple callbacks: one store/finish/drop family per
 * tuple record shape. */
export function manglePromiseAllTuple(n: number): string {
  return `sc_pall_${n}`;
}
/** Emitted child-process exit adapter (the (code: number | null) callback
 * shape), interned per union id. */
export function mangleChildExitThunk(n: number): string {
  return `sc_chexit_${n}`;
}
/** Emitted dgram message adapter (the (msg: Buffer, rinfo) listener shape
 * — the rinfo RECORD is program data), interned per shape id. */
export function mangleDgramMsgThunk(n: number): string {
  return `sc_dgmsg_${n}`;
}
/** Emitted child-stream data adapter (the (chunk: Buffer | string)-union
 * listener shape — the union's tags are program data), interned per
 * union id. */
export function mangleChildDataThunk(n: number): string {
  return `sc_chdata_${n}`;
}
/** Emitted bound-close adapter (`server.close.bind(server)` — the
 * callback union's tags are program data), interned per union id. */
export function mangleCloseBindThunk(n: number): string {
  return `sc_clsbnd_${n}`;
}
/** Emitted close-override zero-arg wrapper (`server.close = fn`),
 * interned per (union id, return kind). */
export function mangleCloseOverrideWrap(n: number): string {
  return `sc_ovwrap_${n}`;
}
/** Emitted dns.lookup callback adapter (the (err: Error | null, address,
 * family?) shape — the union's tags are program data), interned per
 * (union id, param count). */
export function mangleDnsLookupThunk(n: number): string {
  return `sc_dnslk_${n}`;
}
/** Emitted fs.rename callback adapter (the Error | null union's tags are
 * program data), interned per callback type. */
export function mangleFsRenameThunk(n: number): string {
  return `sc_fsren_${n}`;
}
/** Emitted SNI answer-closure thunk (the `(err, ctx?) => void` callback a
 * TLS server's SNICallback receives — its unions' tags are program data),
 * interned per cb func-type key. */
export function mangleSniAnswerThunk(n: number): string {
  return `sc_snians_${n}`;
}
/** Emitted net.connect lookup answer thunk (the `(err, addresses) => void`
 * callback the caller's lookup option receives — its err union's tags and
 * the address record's layout are program data), interned per cb
 * func-type key. */
export function mangleNetLookupAnswerThunk(n: number): string {
  return `sc_netlk_${n}`;
}
/** Emitted CONNECT-listener adapter for a union socket slot (the h2
 * compat listener — its union's tag is program data), interned per cb
 * func-type key. */
export function mangleConnectSockThunk(n: number): string {
  return `sc_h2conn_${n}`;
}
export function mangleConnectResThunk(n: number): string {
  return `sc_h2conn_res_${n}`;
}

/** Emitted EventEmitter listener invoke adapter (va_list → the listener's
 * typed parameter prefix, each retained per the callee-owns convention),
 * interned per listener func-type key. */
export function mangleEmitterInvokeThunk(n: number): string {
  return `sc_eeinv_${n}`;
}

/** Emitted stream option-callback invoke adapter (the runtime calls the
 * user's read/write/... closure through it, stream-as-`this` first),
 * interned per (kind, callback func-type) key. */
export function mangleStreamCbThunk(n: number): string {
  return `sc_scbinv_${n}`;
}

/** Emitted stream completion-callback closure fn (the `callback` handed
 * to a user's write/final/destroy/transform/flush), interned per
 * (kind, done func-type) key. */
export function mangleStreamDoneFn(n: number): string {
  return `sc_sdone_${n}`;
}
