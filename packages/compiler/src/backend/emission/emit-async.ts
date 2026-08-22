/* Async C emission: the per-async-function argpack/trampoline/spawn-wrapper
 * scaffolding, plus the interned resolve/child-exit thunks that adapt typed
 * payloads onto the runtime's promise and child-process machinery. */
import type { CEmitter } from "./emitter.js";
import { mangleArgPack, mangleAsyncSpawn, mangleChildDataThunk, mangleChildExitThunk, mangleCloseBindThunk, mangleCloseOverrideWrap, mangleConnectResThunk, mangleConnectSockThunk, mangleDgramMsgThunk, mangleDnsLookupThunk, mangleField, mangleFsRenameThunk, mangleFunction, mangleGenDrop, mangleGenResThunk, mangleGenSpawn, mangleGlobal, mangleLocal, mangleRaceThunk, mangleRawParam, mangleNetLookupAnswerThunk, mangleEmitterInvokeThunk, mangleStreamCbThunk, mangleStreamDoneFn, mangleRecordNew, mangleRecordRelease, mangleRecordStruct, mangleResolveThunk, mangleSniAnswerThunk, mangleTrampoline } from "../mangle.js";
import { cDecl, cType, releaseCallC, retainCallC, vAdapters } from "./emit-types.js";
import { IrType, isRefCounted, isUnitType, typeEquals, typeKey } from "../../ir/nodes.js";

/** Per-async-function machinery: an argument pack, a fiber trampoline
   * (unpacks, runs the ordinary compiled body, settles the promise), and a
   * spawn wrapper call sites use. Lifted async lambdas additionally thread
   * their closure env through the pack (+1, released after the body). */
  export function emitAsyncScaffolding(E: CEmitter, out: string[]): void {
    for (const fn of E.mod.functions) {
      if (!fn.async) continue;
      const pack = mangleArgPack(fn.name);
      const lifted = fn.captures !== undefined;
      const fields: string[] = [];
      if (lifted) fields.push("ScrClosure *sc_env;");
      const boxedIds = new Set(fn.locals.filter((l) => l.boxed).map((l) => l.id));
      const pname = (p: { localId: string }) =>
        boxedIds.has(p.localId) ? mangleRawParam(p.localId) : mangleLocal(p.localId);
      for (const p of fn.params) fields.push(`${cDecl(p.type, pname(p))};`);
      out.push(``, `typedef struct { ${fields.join(" ") || "char sc_unused;"} } ${pack};`);

      const callArgs = [
        ...(lifted ? ["sc_a.sc_env"] : []),
        ...fn.params.map((p) => `sc_a.${pname(p)}`),
      ].join(", ");
      const ret = fn.returnType;
      const bodyCall = `${mangleFunction(fn.name)}(${callArgs})`;
      const lines: string[] = [
        `static void ${mangleTrampoline(fn.name)}(ScrFiber *sc_self, void *sc_ap0) {`,
        `  ${pack} sc_a = *(${pack} *)sc_ap0;`,
        `  free(sc_ap0);`,
      ];
      if (ret.kind === "void") {
        lines.push(`  ${bodyCall};`);
      } else {
        lines.push(`  ${cDecl(ret, "sc_r")} = ${bodyCall};`);
      }
      if (lifted) lines.push(`  scr_closure_release(sc_a.sc_env);`);
      lines.push(`  if (!scr_exc_pending()) {`);
      switch (ret.kind) {
        case "void":
          lines.push(`    scr_promise_fulfill_void(scr_fiber_promise(sc_self));`);
          break;
        case "f64":
        case "date":
          lines.push(`    scr_promise_fulfill_f64(scr_fiber_promise(sc_self), sc_r);`);
          break;
        case "bool":
          lines.push(`    scr_promise_fulfill_bool(scr_fiber_promise(sc_self), sc_r);`);
          break;
        case "string":
          lines.push(`    scr_promise_fulfill_str(scr_fiber_promise(sc_self), sc_r);`);
          break;
        default: {
          const v = vAdapters(ret);
          lines.push(
            `    scr_promise_fulfill_ref(scr_fiber_promise(sc_self), sc_r, ${v.retain}, ${v.release}, ${E.traceArgC(ret)});`,
          );
        }
      }
      lines.push(`  }`);
      if (ret.kind !== "void" && isRefCounted(ret)) {
        // An escaping throw means sc_r is the never-read dummy (NULL).
        lines.push(`  else { ${releaseCallC(ret, "sc_r")}; }`);
      }
      lines.push(`}`);
      out.push(...lines);

      const spawnParams = [
        ...(lifted ? ["ScrClosure *sc_env"] : []),
        ...fn.params.map((p) => cDecl(p.type, pname(p))),
      ];
      const cache = fn.asyncCacheGlobal !== undefined ? mangleGlobal(fn.asyncCacheGlobal) : null;
      const cycleCache =
        fn.asyncCycleCacheGlobal !== undefined ? mangleGlobal(fn.asyncCycleCacheGlobal) : null;
      out.push(
        `static ScrPromise *${mangleAsyncSpawn(fn.name)}(${spawnParams.join(", ") || "void"}) {`,
        ...(cache !== null
          ? [`  if (${cache}) return scr_promise_retain(${cache});`]
          : []),
        `  ${pack} *sc_ap = malloc(sizeof *sc_ap);`,
        `  if (!sc_ap) { scr_trap("scriptc: out of memory\\n"); }`,
        ...(lifted ? [`  sc_ap->sc_env = scr_closure_retain(sc_env);`] : []),
        ...fn.params.map((p) => `  sc_ap->${pname(p)} = ${pname(p)};`),
        `  ScrPromise *sc_p = scr_async_spawn(&${mangleTrampoline(fn.name)}, sc_ap);`,
        ...(cache !== null
          ? [
              // Module evaluation promises are loader-owned from the
              // moment evaluation starts. Mark even a pending promise
              // handled before a later sibling initializer can throw and
              // unwind past the dependency wait.
              `  scr_promise_mark_handled(sc_p);`,
            ]
          : []),
        ...(cache !== null
          ? [
              // scr_async_spawn runs eagerly. An admitted async import
              // cycle can therefore re-enter this initializer after its
              // guard sets but before this outer spawn returns; that
              // guarded inner spawn temporarily fills the cache. Replace
              // it ownership-safely when the real evaluation promise
              // arrives.
              `  ScrPromise *sc_cache_owned = scr_promise_retain(sc_p);`,
              `  scr_promise_release(${cache});`,
              `  ${cache} = sc_cache_owned;`,
            ]
          : []),
        ...(cycleCache !== null
          ? [
              // Every member of an async SCC publishes while eager spawn
              // recursion unwinds. The outermost wrapper writes last, so
              // this records the member that actually rooted evaluation.
              `  ScrPromise *sc_cycle_cache_owned = scr_promise_retain(sc_p);`,
              `  scr_promise_release(${cycleCache});`,
              `  ${cycleCache} = sc_cycle_cache_owned;`,
            ]
          : []),
        `  return sc_p;`,
        `}`,
      );
    }
    emitGenScaffolding(E, out);
  }

/** Per-generator-function machinery — the async scaffolding's lazy
   * sibling: the same argument pack, a fiber trampoline whose epilogue
   * stores the COMPLETION value (or consumes the GENRET sentinel,
   * promoting the parked .return value), a spawn wrapper that only
   * ALLOCATES the suspended fiber (nothing runs until the first .next()),
   * and the never-started teardown that drops the packed (+1) arguments. */
  function emitGenScaffolding(E: CEmitter, out: string[]): void {
    for (const fn of E.mod.functions) {
      if (!fn.generator) continue;
      const pack = mangleArgPack(fn.name);
      const lifted = fn.captures !== undefined;
      const fields: string[] = [];
      if (lifted) fields.push("ScrClosure *sc_env;");
      const boxedIds = new Set(fn.locals.filter((l) => l.boxed).map((l) => l.id));
      const pname = (p: { localId: string }) =>
        boxedIds.has(p.localId) ? mangleRawParam(p.localId) : mangleLocal(p.localId);
      for (const p of fn.params) fields.push(`${cDecl(p.type, pname(p))};`);
      out.push(``, `typedef struct { ${fields.join(" ") || "char sc_unused;"} } ${pack};`);

      const callArgs = [
        ...(lifted ? ["sc_a.sc_env"] : []),
        ...fn.params.map((p) => `sc_a.${pname(p)}`),
      ].join(", ");
      const ret = fn.returnType;
      const bodyCall = `${mangleFunction(fn.name)}(${callArgs})`;
      const lines: string[] = [
        `static void ${mangleTrampoline(fn.name)}(ScrFiber *sc_self, void *sc_ap0) {`,
        `  ${pack} sc_a = *(${pack} *)sc_ap0;`,
        `  free(sc_ap0);`,
      ];
      if (ret.kind === "void") {
        lines.push(`  ${bodyCall};`);
      } else {
        lines.push(`  ${cDecl(ret, "sc_r")} = ${bodyCall};`);
      }
      if (lifted) lines.push(`  scr_closure_release(sc_a.sc_env);`);
      lines.push(`  ScrGen *sc_g = scr_gen_of_fiber(sc_self);`);
      // Normal completion stores the (typed) return value; void completes
      // with the NONE slot — JS's undefined done-value. A GENRET unwind
      // consumes the sentinel and promotes the parked .return value; a
      // real exception stays pending (the consumer-side resume moves it).
      const store = (() => {
        switch (ret.kind) {
          case "void":
            return null;
          case "f64":
          case "date":
            return `scr_gen_out_f64(sc_g, sc_r);`;
          case "bool":
            return `scr_gen_out_bool(sc_g, sc_r);`;
          default: {
            const v = vAdapters(ret);
            return `scr_gen_out_ref(sc_g, sc_r, ${v.release});`;
          }
        }
      })();
      lines.push(
        `  if (!scr_exc_pending()) {`,
        ...(store ? [`    ${store}`] : [`    /* void body: the done value is undefined (NONE) */`]),
        `  } else {`,
        `    if (scr_exc_genret_pending()) { scr_exc_clear(); scr_gen_ret_to_out(sc_g); }`,
        ...(ret.kind !== "void" && isRefCounted(ret)
          ? [`    ${releaseCallC(ret, "sc_r")}; /* unwound: the never-read dummy */`]
          : []),
        `  }`,
        `}`,
      );
      out.push(...lines);

      const spawnParams = [
        ...(lifted ? ["ScrClosure *sc_env"] : []),
        ...fn.params.map((p) => cDecl(p.type, pname(p))),
      ];
      out.push(
        `static void ${mangleGenDrop(fn.name)}(void *sc_ap0) {`,
        `  ${pack} sc_a = *(${pack} *)sc_ap0;`,
        `  free(sc_ap0);`,
        ...(lifted ? [`  scr_closure_release(sc_a.sc_env);`] : []),
        ...fn.params
          .filter((p) => isRefCounted(p.type))
          .map((p) => `  ${releaseCallC(p.type, `sc_a.${pname(p)}`)};`),
        ...(!lifted && !fn.params.some((p) => isRefCounted(p.type)) ? [`  (void)sc_a;`] : []),
        `}`,
        `static ScrGen *${mangleGenSpawn(fn.name)}(${spawnParams.join(", ") || "void"}) {`,
        `  ${pack} *sc_ap = malloc(sizeof *sc_ap);`,
        `  if (!sc_ap) { scr_trap("scriptc: out of memory\\n"); }`,
        ...(lifted ? [`  sc_ap->sc_env = scr_closure_retain(sc_env);`] : []),
        ...fn.params.map((p) => `  sc_ap->${pname(p)} = ${pname(p)};`),
        `  return scr_gen_new(&${mangleTrampoline(fn.name)}, sc_ap, &${mangleGenDrop(fn.name)});`,
        `}`,
      );
    }
  }

/** Interned per-union child exit adapter: the runtime invokes
   * adapter(cb, has_code, code, signal_name); the adapter builds the
   * `number | null` union value (tags are program data — the frontend
   * guaranteed the param IS that union) and calls the listener, which
   * owns the union param per the universal convention (unit-arm
   * instances are immortal; their release is a no-op). The one-param
   * shape ignores the signal. */
  export function childExitThunkFor(E: CEmitter, param: IrType): string {
    if (param.kind !== "union") throw new Error("emitter bug: exit listener param not a union");
    const key = param.unionId;
    let sym = E.childExitThunks.get(key);
    if (!sym) {
      sym = mangleChildExitThunk(E.childExitThunks.size);
      E.childExitThunks.set(key, sym);
      const def = E.unionsById.get(param.unionId);
      const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (f64Tag < 0 || nullTag < 0) {
        throw new Error("emitter bug: exit listener union lacks its arms");
      }
      E.walkerProtos.push(
        `static void ${sym}(ScrClosure *sc_cb, bool sc_has, double sc_code, const char *sc_sig);`,
      );
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_cb, bool sc_has, double sc_code, const char *sc_sig) {`,
        `  (void)sc_sig;`,
        `  ScrUnion *sc_u = sc_has ? scr_union_new_f64(${f64Tag}, sc_code)`,
        `                           : ${E.unitInstanceRef(param.unionId, nullTag)};`,
        `  ((void (*)(ScrClosure *, ScrUnion *))sc_cb->fn)(sc_cb, sc_u);`,
        `}`,
      );
    }
    return sym;
  }

/** The TWO-parameter exit adapter — Node's `(code, signal)` listener:
   * the code union as above plus the signal as its own `string | null`
   * union (a fresh string from the runtime's static signal name when a
   * signal killed the child, the null arm otherwise). */
  export function childExitThunkFor2(E: CEmitter, codeParam: IrType, sigParam: IrType): string {
    if (codeParam.kind !== "union" || sigParam.kind !== "union") {
      throw new Error("emitter bug: exit listener params not unions");
    }
    const key = `${codeParam.unionId}+${sigParam.unionId}`;
    let sym = E.childExitThunks.get(key);
    if (!sym) {
      sym = mangleChildExitThunk(E.childExitThunks.size);
      E.childExitThunks.set(key, sym);
      const codeDef = E.unionsById.get(codeParam.unionId);
      const f64Tag = codeDef ? codeDef.arms.findIndex((a) => a.kind === "f64") : -1;
      const codeNullTag = codeDef ? codeDef.arms.findIndex((a) => a.kind === "nullT") : -1;
      const sigDef = E.unionsById.get(sigParam.unionId);
      const strTag = sigDef ? sigDef.arms.findIndex((a) => a.kind === "string") : -1;
      const sigNullTag = sigDef ? sigDef.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (f64Tag < 0 || codeNullTag < 0 || strTag < 0 || sigNullTag < 0) {
        throw new Error("emitter bug: exit listener unions lack their arms");
      }
      E.walkerProtos.push(
        `static void ${sym}(ScrClosure *sc_cb, bool sc_has, double sc_code, const char *sc_sig);`,
      );
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_cb, bool sc_has, double sc_code, const char *sc_sig) {`,
        `  ScrUnion *sc_u = sc_has ? scr_union_new_f64(${f64Tag}, sc_code)`,
        `                           : ${E.unitInstanceRef(codeParam.unionId, codeNullTag)};`,
        `  ScrUnion *sc_s = sc_sig`,
        `      ? scr_union_new_ref(${strTag}, scr_str_new(sc_sig, strlen(sc_sig)), &scr_str_retain_v, &scr_str_release_v, NULL)`,
        `      : ${E.unitInstanceRef(sigParam.unionId, sigNullTag)};`,
        `  ((void (*)(ScrClosure *, ScrUnion *, ScrUnion *))sc_cb->fn)(sc_cb, sc_u, sc_s);`,
        `}`,
      );
    }
    return sym;
  }

/** Interned per-union child-stream data adapter: the runtime invokes
   * adapter(cb, chunk) with the chunk BORROWED; the adapter wraps a
   * retained chunk at the union's Buffer arm (the frontend guaranteed
   * the arm exists — the ngrok `Buffer | string` listener; strings never
   * fire from a pipe) and calls the listener, which owns the union param
   * per the universal convention. */
  export function childDataThunkFor(E: CEmitter, param: IrType): string {
    if (param.kind !== "union") throw new Error("emitter bug: stream data listener param not a union");
    const key = param.unionId;
    let sym = E.childDataThunks.get(key);
    if (!sym) {
      sym = mangleChildDataThunk(E.childDataThunks.size);
      E.childDataThunks.set(key, sym);
      const def = E.unionsById.get(param.unionId);
      const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
      if (bytesTag < 0) {
        throw new Error("emitter bug: stream data listener union lacks its Buffer arm");
      }
      E.walkerProtos.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrBytes *sc_chunk);`,
      );
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrBytes *sc_chunk) {`,
        `  ScrUnion *sc_u = scr_union_new_ref(${bytesTag}, scr_bytes_retain(sc_chunk), &scr_bytes_retain_v, &scr_bytes_release_v, NULL);`,
        `  ((void (*)(ScrClosure *, ScrUnion *))sc_cb->fn)(sc_cb, sc_u);`,
        `}`,
      );
    }
    return sym;
  }

/** Interned per-union bound-close adapter (`server.close.bind(server)`
   * as a value): invoked through the closure ABI with the callback-union
   * argument, it closes the server DIRECTLY (never through the override —
   * the proxy-through idiom cannot recurse), registering a present
   * callback as a once-'close' listener — a ONE-param callback (Node's
   * `(err?: Error) => void`) behind an emitted zero-arg trampoline that
   * fires it with the undefined arm (a clean close carries no error) —
   * and answers the +1 server (Node's chaining return). */
  export function closeBindThunkFor(E: CEmitter, cbUnion: IrType, retServer: boolean): string {
    if (cbUnion.kind !== "union") throw new Error("emitter bug: bound-close callback param not a union");
    const key = `${cbUnion.unionId}:${retServer ? "srv" : "void"}`;
    let sym = E.closeBindThunks.get(key);
    if (sym) return sym;
    sym = mangleCloseBindThunk(E.closeBindThunks.size);
    E.closeBindThunks.set(key, sym);
    const def = E.unionsById.get(cbUnion.unionId);
    const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
    const funcArm = funcTag >= 0 ? (def!.arms[funcTag] as IrType & { kind: "func" }) : null;
    if (!funcArm) throw new Error("emitter bug: bound-close callback union lacks its func arm");
    const oneParam = funcArm.params.length === 1;
    let trampoline: string | null = null;
    if (oneParam) {
      const errParam = funcArm.params[0]!;
      if (errParam.kind !== "union") {
        throw new Error("emitter bug: bound-close callback's err param is not a union");
      }
      const errDef = E.unionsById.get(errParam.unionId);
      const undefTag = errDef ? errDef.arms.findIndex((a) => a.kind === "undefinedT") : -1;
      if (undefTag < 0) throw new Error("emitter bug: bound-close err union lacks its undefined arm");
      trampoline = `${sym}_cb`;
      E.walkerProtos.push(`static void ${trampoline}(ScrClosure *sc_self);`);
      E.walkerDefs.push(
        `static void ${trampoline}(ScrClosure *sc_self) { /* close cb: fire with no error */`,
        `  ScrClosure *sc_inner = (ScrClosure *)scr_box_get_ref(sc_self->caps[0]); /* +1 */`,
        `  ((void (*)(ScrClosure *, ScrUnion *))sc_inner->fn)(sc_inner, ${E.unitInstanceRef(errParam.unionId, undefTag)});`,
        `  scr_closure_release(sc_inner);`,
        `}`,
      );
    }
    const retC = retServer ? "ScrNetServer *" : "void";
    E.walkerProtos.push(`static ${retC}${retServer ? "" : " "}${sym}(ScrClosure *sc_self, ScrUnion *sc_cb);`);
    E.walkerDefs.push(
      `static ${retC}${retServer ? "" : " "}${sym}(ScrClosure *sc_self, ScrUnion *sc_cb) { /* bound server.close */`,
      `  ScrNetServer *sc_srv = (ScrNetServer *)scr_box_get_ref(sc_self->caps[0]); /* +1 */`,
      `  ScrClosure *sc_reg = NULL;`,
      `  if (sc_cb->tag == ${funcTag}) {`,
      ...(oneParam
        ? [
            `    sc_reg = scr_closure_new((void *)&${trampoline}, 1);`,
            `    sc_reg->caps[0] = scr_box_new(SCR_BOX_FUNC);`,
            `    scr_box_set_ref(sc_reg->caps[0], scr_closure_retain((ScrClosure *)scr_union_peek(sc_cb)));`,
          ]
        : [`    sc_reg = scr_closure_retain((ScrClosure *)scr_union_peek(sc_cb));`]),
      `  }`,
      `  scr_union_release(sc_cb); /* the callee owns its +1 param */`,
      `  scr_net_server_close_direct(sc_srv, sc_reg); /* sc_reg moves */`,
      ...(retServer
        ? [`  return sc_srv; /* +1 from the env read */`]
        : [`  scr_net_server_release(sc_srv);`]),
      `}`,
    );
    return sym;
  }

/** Interned close-override zero-arg wrapper (`server.close = fn`): the
   * stored override must be invocable by the runtime WITHOUT program
   * types, so this wrapper carries the user function and fires it with
   * the undefined-arm callback argument (tags are program data),
   * releasing the chaining-return server when the signature answers one. */
  export function closeOverrideWrapFor(E: CEmitter, cbUnion: IrType, retServer: boolean): string {
    if (cbUnion.kind !== "union") throw new Error("emitter bug: close-override callback param not a union");
    const key = `${cbUnion.unionId}:${retServer ? "srv" : "void"}`;
    let sym = E.closeOverrideWraps.get(key);
    if (sym) return sym;
    sym = mangleCloseOverrideWrap(E.closeOverrideWraps.size);
    E.closeOverrideWraps.set(key, sym);
    const def = E.unionsById.get(cbUnion.unionId);
    const undefTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
    if (undefTag < 0) throw new Error("emitter bug: close-override callback union lacks its undefined arm");
    E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_self);`);
    E.walkerDefs.push(
      `static void ${sym}(ScrClosure *sc_self) { /* close override wrapper */`,
      `  ScrClosure *sc_inner = (ScrClosure *)scr_box_get_ref(sc_self->caps[0]); /* +1 */`,
      ...(retServer
        ? [
            `  ScrNetServer *sc_r = ((ScrNetServer *(*)(ScrClosure *, ScrUnion *))sc_inner->fn)(sc_inner, ${E.unitInstanceRef(cbUnion.unionId, undefTag)});`,
            `  scr_net_server_release(sc_r); /* the chaining return is unobserved here */`,
          ]
        : [
            `  ((void (*)(ScrClosure *, ScrUnion *))sc_inner->fn)(sc_inner, ${E.unitInstanceRef(cbUnion.unionId, undefTag)});`,
          ]),
      `  scr_closure_release(sc_inner);`,
      `}`,
    );
    return sym;
  }

/** Interned per-shape dgram message adapter for the TWO-parameter
   * (msg: Buffer, rinfo) listener: the rinfo RECORD is program data, so
   * the adapter builds it from the runtime's parts (address/family
   * borrowed and retained in; port/size by value) and calls the listener,
   * which owns both params per the universal convention (msg retains like
   * the net data thunk). Zero/one-param listeners take the runtime's own
   * scr_dgram_msg_thunk0/1. */
  export function dgramMsgThunkFor(E: CEmitter, param: IrType): string {
    if (param.kind !== "record") throw new Error("emitter bug: message listener rinfo not a record");
    const key = param.shapeId;
    let sym = E.dgramMsgThunks.get(key);
    if (!sym) {
      sym = mangleDgramMsgThunk(E.dgramMsgThunks.size);
      E.dgramMsgThunks.set(key, sym);
      const struct = mangleRecordStruct(param.shapeId);
      E.walkerProtos.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrBytes *sc_msg, ScrStr *sc_addr, ScrStr *sc_family, double sc_port, double sc_size);`,
      );
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrBytes *sc_msg, ScrStr *sc_addr, ScrStr *sc_family, double sc_port, double sc_size) {`,
        `  ${struct} *sc_ri = ${mangleRecordNew(param.shapeId)}();`,
        `  sc_ri->${mangleField("address")} = scr_str_retain(sc_addr);`,
        `  sc_ri->${mangleField("family")} = scr_str_retain(sc_family);`,
        `  sc_ri->${mangleField("port")} = sc_port;`,
        `  sc_ri->${mangleField("size")} = sc_size;`,
        `  ((void (*)(ScrClosure *, ScrBytes *, ${struct} *))sc_cb->fn)(sc_cb, scr_bytes_retain(sc_msg), sc_ri);`,
        `}`,
      );
    }
    return sym;
  }

/** Interned dns.lookup callback adapter, per (union id, param count):
   * the runtime invokes adapter(cb, errmsg-or-NULL, address, family) with
   * everything borrowed; the adapter builds the `Error | null` first
   * argument (tags are program data — the frontend pinned the union) and
   * calls the listener with as many arguments as it declared, each owned
   * per the universal convention. */
  export function dnsLookupThunkFor(E: CEmitter, cbT: IrType): string {
    if (cbT.kind !== "func") throw new Error("emitter bug: dns.lookup callback not a func");
    const nparams = cbT.params.length;
    if (nparams === 0) return "scr_dns_thunk0";
    const errT = cbT.params[0]!;
    if (errT.kind !== "union") throw new Error("emitter bug: dns.lookup err param not a union");
    const key = `${errT.unionId}/${nparams}`;
    let sym = E.dnsLookupThunks.get(key);
    if (!sym) {
      sym = mangleDnsLookupThunk(E.dnsLookupThunks.size);
      E.dnsLookupThunks.set(key, sym);
      const def = E.unionsById.get(errT.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (errTag < 0 || nullTag < 0) {
        throw new Error("emitter bug: dns.lookup err union lacks its arms");
      }
      const callSig = ["ScrClosure *", "ScrUnion *", ...(nparams >= 2 ? ["ScrStr *"] : []), ...(nparams >= 3 ? ["double"] : [])].join(", ");
      const callArgs = ["sc_cb", "sc_u", ...(nparams >= 2 ? ["scr_str_retain(sc_addr)"] : []), ...(nparams >= 3 ? ["sc_family"] : [])].join(", ");
      E.walkerProtos.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrStr *sc_err, ScrStr *sc_addr, double sc_family);`,
      );
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrStr *sc_err, ScrStr *sc_addr, double sc_family) {`,
        `  (void)sc_addr; (void)sc_family;`,
        `  ScrUnion *sc_u = sc_err`,
        `      ? scr_union_new_ref(${errTag}, scr_error_new(0, sc_err), &scr_error_retain_v, &scr_error_release_v, NULL)`,
        `      : ${E.unitInstanceRef(errT.unionId, nullTag)};`,
        `  ((void (*)(${callSig}))sc_cb->fn)(${callArgs});`,
        `}`,
      );
    }
    return sym;
  }

/** Interned fs.rename callback adapter. The runtime supplies a borrowed
 * ScrError (or NULL); the adapter builds the callback's program-specific
 * Error | null union, or a dyn error/null for checkJs callbacks. */
  export function fsRenameThunkFor(E: CEmitter, cbT: IrType): string {
    if (cbT.kind !== "func") throw new Error("emitter bug: fs.rename callback not a func");
    if (cbT.params.length === 0) return "scr_fs_rename_thunk0";
    const param = cbT.params[0]!;
    const key = typeKey(cbT);
    let sym = E.fsRenameThunks.get(key);
    if (sym) return sym;
    sym = mangleFsRenameThunk(E.fsRenameThunks.size);
    E.fsRenameThunks.set(key, sym);
    E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_cb, ScrError *sc_err);`);
    if (param.kind === "dyn") {
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_cb, ScrError *sc_err) {`,
        `  ScrDyn *sc_arg = sc_err ? scr_dyn_from_error(sc_err) : scr_dyn_new_null();`,
        `  ((void (*)(ScrClosure *, ScrDyn *))sc_cb->fn)(sc_cb, sc_arg);`,
        `}`,
      );
      return sym;
    }
    if (param.kind !== "union") throw new Error("emitter bug: fs.rename error param not a union");
    const def = E.unionsById.get(param.unionId);
    const errTag = def ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error") : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (errTag < 0 || nullTag < 0) throw new Error("emitter bug: fs.rename error union lacks its arms");
    E.walkerDefs.push(
      `static void ${sym}(ScrClosure *sc_cb, ScrError *sc_err) {`,
      `  ScrUnion *sc_u = sc_err`,
      `      ? scr_union_new_ref(${errTag}, scr_error_retain(sc_err), &scr_error_retain_v, &scr_error_release_v, NULL)`,
      `      : ${E.unitInstanceRef(param.unionId, nullTag)};`,
      `  ((void (*)(ScrClosure *, ScrUnion *))sc_cb->fn)(sc_cb, sc_u);`,
      `}`,
    );
    return sym;
  }

/** Interned CONNECT-listener adapter for a UNION socket slot — the h2
   * compat listener (`(req, resOrSocket: Http2ServerResponse | net.Socket)
   * => void`): the runtime fires (cb, req, sock, head) like an upgrade;
   * the adapter wraps the socket at the union's netSocket arm (its tag is
   * program data) and drops `head` when the listener declares two params.
   * All three runtime args arrive +1; the union takes the socket's. */
  export function connectSockThunkFor(E: CEmitter, cbT: IrType): string {
    if (cbT.kind !== "func" || cbT.params[1]?.kind !== "union") {
      throw new Error("emitter bug: connect listener union shape (frontend must fence)");
    }
    const key = typeKey(cbT);
    let sym = E.connectSockThunks.get(key);
    if (sym) return sym;
    sym = mangleConnectSockThunk(E.connectSockThunks.size);
    E.connectSockThunks.set(key, sym);
    const sockT = cbT.params[1];
    const def = E.unionsById.get(sockT.unionId);
    const tag = def ? def.arms.findIndex((a) => a.kind === "netSocket") : -1;
    if (tag < 0) throw new Error("emitter bug: connect listener union lacks its socket arm");
    const three = cbT.params.length === 3;
    E.walkerProtos.push(
      `static void ${sym}(ScrClosure *sc_cb, ScrHttpReq *sc_req, ScrNetSocket *sc_sock, ScrBytes *sc_head);`,
    );
    E.walkerDefs.push(
      `static void ${sym}(ScrClosure *sc_cb, ScrHttpReq *sc_req, ScrNetSocket *sc_sock, ScrBytes *sc_head) {`,
      ...(three ? [] : [`  scr_bytes_release(sc_head);`]),
      `  ScrUnion *sc_u = scr_union_new_ref(${tag}, sc_sock, &scr_net_sock_retain_v, &scr_net_sock_release_v, NULL);`,
      three
        ? `  ((void (*)(ScrClosure *, ScrHttpReq *, ScrUnion *, ScrBytes *))sc_cb->fn)(sc_cb, sc_req, sc_u, sc_head);`
        : `  ((void (*)(ScrClosure *, ScrHttpReq *, ScrUnion *))sc_cb->fn)(sc_cb, sc_req, sc_u);`,
      `}`,
    );
    return sym;
  }

  export function connectResThunkFor(E: CEmitter, cbT: IrType): string {
    if (cbT.kind !== "func") throw new Error("emitter bug: connect listener shape");
    const key = `res:${typeKey(cbT)}`;
    let sym = E.connectSockThunks.get(key);
    if (sym) return sym;
    sym = mangleConnectResThunk(E.connectSockThunks.size);
    E.connectSockThunks.set(key, sym);
    const p1 = cbT.params[1];
    const def = p1?.kind === "union" ? E.unionsById.get(p1.unionId) : undefined;
    const tag = def ? def.arms.findIndex((a) => a.kind === "httpRes") : -1;
    if (p1?.kind === "union" && tag < 0) throw new Error("emitter bug: connect listener union lacks its response arm");
    E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_cb, ScrHttpReq *sc_req, ScrHttpRes *sc_res);`);
    const second = p1?.kind === "union"
      ? `ScrUnion *sc_u = scr_union_new_ref(${tag}, sc_res, &scr_http_res_retain_v, &scr_http_res_release_v, NULL);`
      : "";
    const arg = p1?.kind === "union" ? "sc_u" : "sc_res";
    E.walkerDefs.push(
      `static void ${sym}(ScrClosure *sc_cb, ScrHttpReq *sc_req, ScrHttpRes *sc_res) {`,
      ...(second ? [`  ${second}`] : []),
      ...(cbT.params.length === 0
        ? ["  scr_http_req_release(sc_req);", "  scr_http_res_release(sc_res);", "  ((void (*)(ScrClosure *))sc_cb->fn)(sc_cb);"]
        : cbT.params.length === 1
          ? ["  scr_http_res_release(sc_res);", "  ((void (*)(ScrClosure *, ScrHttpReq *))sc_cb->fn)(sc_cb, sc_req);"]
          : [`  ((void (*)(ScrClosure *, ScrHttpReq *, ${p1?.kind === "union" ? "ScrUnion" : "ScrHttpRes"} *))sc_cb->fn)(sc_cb, sc_req, ${arg});`]),
      `}`,
    );
    return sym;
  }

/** Interned net.connect-lookup answer thunk: the fn of the runtime-minted
   * callback the caller's `lookup` option receives (the SNI-answer
   * pattern). COMPILED code calls it per its static type — `(err:
   * ErrnoException | null, addresses: { address: string, ... }[]) =>
   * void` — so the thunk decodes the program-interned err union (null
   * tag) and the addresses record's field layout down to the runtime's
   * (has_err, message, ip-list) answer. Params arrive +1 and release
   * here; the extracted message/ips hand over +1. */
  export function netLookupAnswerThunkFor(E: CEmitter, cbT: IrType): string {
    if (cbT.kind !== "func" || cbT.params.length !== 2) {
      throw new Error("emitter bug: lookup answer cb shape (frontend must fence)");
    }
    const key = typeKey(cbT);
    let sym = E.netLookupAnswerThunks.get(key);
    if (sym) return sym;
    sym = mangleNetLookupAnswerThunk(E.netLookupAnswerThunks.size);
    E.netLookupAnswerThunks.set(key, sym);
    const errT = cbT.params[0]!;
    if (errT.kind !== "union") throw new Error("emitter bug: lookup answer err param not a union");
    const errDef = E.unionsById.get(errT.unionId);
    const nullTag = errDef ? errDef.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (nullTag < 0) throw new Error("emitter bug: lookup answer err union lacks its null arm");
    const addrsT = cbT.params[1]!;
    if (addrsT.kind !== "array" || addrsT.elem.kind !== "record") {
      throw new Error("emitter bug: lookup answer addresses param not a record array");
    }
    const recStruct = mangleRecordStruct(addrsT.elem.shapeId);
    const recRelease = mangleRecordRelease(addrsT.elem.shapeId);
    const addrField = mangleField("address");
    E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_self, ScrUnion *sc_err, ScrArr *sc_addrs);`);
    E.walkerDefs.push(
      `static void ${sym}(ScrClosure *sc_self, ScrUnion *sc_err, ScrArr *sc_addrs) {`,
      `  bool sc_has_err = sc_err->tag != ${nullTag};`,
      `  ScrStr *sc_msg = NULL;`,
      `  if (sc_has_err) sc_msg = scr_str_retain(((ScrError *)scr_union_peek(sc_err))->message);`,
      `  ScrArr *sc_ips = NULL;`,
      `  if (!sc_has_err) {`,
      `    double sc_n = scr_arr_len(sc_addrs);`,
      `    sc_ips = scr_arr_new(SCR_ELEM_STR, (size_t)sc_n);`,
      `    for (double sc_i = 0; sc_i < sc_n; sc_i++) {`,
      `      ${recStruct} *sc_r = (${recStruct} *)scr_arr_get_ref(sc_addrs, sc_i);`,
      `      scr_arr_push_ref(sc_ips, scr_str_retain(sc_r->${addrField}));`,
      `      ${recRelease}(sc_r);`,
      `    }`,
      `  }`,
      `  scr_net_lookup_answer(sc_self, sc_has_err, sc_msg, sc_ips);`,
      `  scr_str_release(sc_msg);`,
      `  scr_arr_release(sc_ips);`,
      `  scr_union_release(sc_err);`,
      `  scr_arr_release(sc_addrs);`,
      `}`,
    );
    return sym;
  }

/** Interned SNI answer-closure thunk: the fn of the runtime-minted `cb`
   * a TLS server's SNICallback receives. COMPILED code calls cb per its
   * static type — `(err: Error | null, ctx?: SecureContext) => void`, or
   * a shorter declared shape — so the thunk's signature is that ABI, and
   * it decodes the program-interned unions (tags are program data) down
   * to the runtime's (has_err, ctx-or-NULL) answer. The thunk owns its
   * union params per the universal convention (the ctx payload retains
   * +1 before its union releases; ownership moves to the runtime). */
  export function sniAnswerThunkFor(E: CEmitter, cbT: IrType): string {
    if (cbT.kind !== "func") throw new Error("emitter bug: SNI answer cb not a func");
    const key = typeKey(cbT);
    let sym = E.sniAnswerThunks.get(key);
    if (sym) return sym;
    sym = mangleSniAnswerThunk(E.sniAnswerThunks.size);
    E.sniAnswerThunks.set(key, sym);
    const nparams = cbT.params.length;
    const params = ["ScrClosure *sc_self"];
    const body: string[] = [];
    let hasErr = "false";
    if (nparams >= 1) {
      const errT = cbT.params[0]!;
      if (errT.kind !== "union") throw new Error("emitter bug: SNI answer err param not a union");
      const def = E.unionsById.get(errT.unionId);
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (nullTag < 0) throw new Error("emitter bug: SNI answer err union lacks its null arm");
      params.push("ScrUnion *sc_err");
      hasErr = `sc_err->tag != ${nullTag}`;
    }
    let ctx = "NULL";
    if (nparams >= 2) {
      const ctxT = cbT.params[1]!;
      if (ctxT.kind !== "union") throw new Error("emitter bug: SNI answer ctx param not a union");
      const def = E.unionsById.get(ctxT.unionId);
      const ctxTag = def ? def.arms.findIndex((a) => a.kind === "secureCtx") : -1;
      if (ctxTag < 0) throw new Error("emitter bug: SNI answer ctx union lacks its SecureContext arm");
      params.push("ScrUnion *sc_ctx");
      body.push(
        `  ScrSecureCtx *sc_c = sc_ctx->tag == ${ctxTag} ? scr_secure_ctx_retain((ScrSecureCtx *)scr_union_peek(sc_ctx)) : NULL;`,
        `  scr_union_release(sc_ctx);`,
      );
      ctx = "sc_c";
    }
    body.push(`  bool sc_has_err = ${hasErr};`);
    if (nparams >= 1) body.push(`  scr_union_release(sc_err);`);
    body.push(`  scr_tls_sni_answer(sc_self, sc_has_err, ${ctx});`);
    E.walkerProtos.push(`static void ${sym}(${params.join(", ")});`);
    E.walkerDefs.push(`static void ${sym}(${params.join(", ")}) {`, ...body, `}`);
    return sym;
  }

/** Interned Promise.race fulfillment adapter: converts a settled entry's
   * payload (inner type `from`) into the result promise's inner type `to`
   * and fulfills the destination. Three shapes, mirroring the frontend's
   * compatibility fence: identical types share the runtime's raw copy;
   * a plain entry under a union result wraps into its arm; a sub-union
   * entry re-tags arm-wise (canonical arm order makes the mapping a
   * typeKey lookup). Rejections never reach adapters — the runtime copies
   * them raw. */
  export function raceAdapterFor(E: CEmitter, from: IrType, to: IrType): string {
    if (typeEquals(from, to)) return "scr_promise_adapt_copy";
    const key = `${typeKey(from)}=>${typeKey(to)}`;
    let sym = E.raceThunks.get(key);
    if (sym) return sym;
    sym = mangleRaceThunk(E.raceThunks.size);
    E.raceThunks.set(key, sym);
    if (to.kind !== "union") throw new Error("emitter bug: race adapter to a non-union");
    const toDef = E.unionsById.get(to.unionId);
    if (!toDef) throw new Error("emitter bug: race adapter to an unknown union");
    const tagOf = (t: IrType): number => {
      const tag = toDef.arms.findIndex((a) => typeEquals(a, t));
      if (tag < 0) throw new Error("emitter bug: race adapter arm missing (frontend must fence)");
      return tag;
    };
    const rv = vAdapters(to);
    const fulfill = (value: string): string =>
      `scr_promise_fulfill_ref(sc_dst, ${value}, ${rv.retain}, ${rv.release}, ${E.traceArgC(to)});`;
    E.walkerProtos.push(`static void ${sym}(ScrPromise *sc_dst, ScrPromise *sc_src);`);
    if (from.kind !== "union") {
      // One arm wrap, straight off the payload accessors.
      const tag = tagOf(from);
      let value: string;
      switch (from.kind) {
        case "f64":
          value = `scr_union_new_f64(${tag}, scr_promise_payload_f64(sc_src))`;
          break;
        case "bool":
          value = `scr_union_new_bool(${tag}, scr_promise_payload_bool(sc_src))`;
          break;
        case "string":
          value = `scr_union_new_ref(${tag}, scr_promise_payload_str(sc_src), scr_str_retain_v, scr_str_release_v, NULL)`;
          break;
        default: {
          const fv = vAdapters(from);
          value = `scr_union_new_ref(${tag}, scr_promise_payload_ref(sc_src), ${fv.retain}, ${fv.release}, ${E.traceArgC(from)})`;
        }
      }
      E.walkerDefs.push(
        `static void ${sym}(ScrPromise *sc_dst, ScrPromise *sc_src) {`,
        `  ${fulfill(value)}`,
        `}`,
      );
      return sym;
    }
    // Sub-union re-tag: switch over the entry's arms, rebuild under the
    // result's tags (payloads retained through each arm's own adapters).
    const fromDef = E.unionsById.get(from.unionId);
    if (!fromDef) throw new Error("emitter bug: race adapter from an unknown union");
    const cases = fromDef.arms.map((arm, i) => {
      const tag = tagOf(arm);
      let build: string;
      if (isUnitType(arm)) {
        build = E.unitInstanceRef(to.unionId, tag);
      } else if (arm.kind === "f64") {
        build = `scr_union_new_f64(${tag}, scr_union_get_f64(sc_u))`;
      } else if (arm.kind === "bool") {
        build = `scr_union_new_bool(${tag}, scr_union_get_bool(sc_u))`;
      } else {
        const av = vAdapters(arm);
        build = `scr_union_new_ref(${tag}, ${av.retain}(scr_union_peek(sc_u)), ${av.retain}, ${av.release}, ${E.traceArgC(arm)})`;
      }
      return `  case ${i}: sc_v = ${build}; break;`;
    });
    E.walkerDefs.push(
      `static void ${sym}(ScrPromise *sc_dst, ScrPromise *sc_src) {`,
      `  ScrUnion *sc_u = (ScrUnion *)scr_promise_payload_ref(sc_src);`,
      `  ScrUnion *sc_v = NULL;`,
      `  switch (sc_u->tag) {`,
      ...cases,
      `  default: break;`,
      `  }`,
      `  scr_union_release(sc_u);`,
      `  ${fulfill("sc_v")}`,
      `}`,
    );
    return sym;
  }

/** Interned generator-resume result builder: reads the post-resume state
   * of a generator into a fresh IteratorResult record `{ done, value }`.
   * One helper per generator type (every next/return/throw on it shares
   * the record shape). The value slot: while suspended, the yielded value
   * moves out of the OUT slot into its arm of V (the yield type retags
   * arm-wise into a superset V, the raceAdapterFor technique); once done,
   * a present completion value wraps the same way and an empty OUT is
   * JS's undefined (the interned undefined arm — or the dyn undefined
   * when V is dyn, the any/unknown channel). */
  export function genResultThunkFor(
    E: CEmitter,
    genT: IrType & { kind: "generator" },
    recT: IrType & { kind: "record" },
  ): string {
    const key = typeKey(genT);
    let sym = E.genResThunks.get(key);
    if (sym) return sym;
    sym = mangleGenResThunk(E.genResThunks.size);
    E.genResThunks.set(key, sym);
    const struct = mangleRecordStruct(recT.shapeId);
    const shape = E.mod.records?.find((r) => r.id === recT.shapeId);
    const valueT = shape?.fields.find((f) => f.name === "value")?.type;
    if (!valueT) throw new Error("emitter bug: genResume record lacks its value field");
    const lines: string[] = [
      `static ${struct} *${sym}(ScrGen *sc_g) {`,
      `  ${struct} *sc_r = ${mangleRecordNew(recT.shapeId)}();`,
      `  bool sc_d = scr_gen_done(sc_g);`,
      `  sc_r->${mangleField("done")} = sc_d;`,
    ];
    if (valueT.kind === "dyn") {
      // The any/unknown channel: OUT holds a dyn (or nothing — undefined).
      lines.push(
        `  sc_r->${mangleField("value")} = scr_gen_out_has(sc_g)`,
        `      ? (ScrDyn *)scr_gen_take_out_ref(sc_g)`,
        `      : scr_dyn_retain(scr_dyn_undefined());`,
      );
    } else {
      if (valueT.kind !== "union") {
        throw new Error("emitter bug: genResume value slot is neither dyn nor a union");
      }
      const def = E.unionsById.get(valueT.unionId);
      if (!def) throw new Error("emitter bug: genResume value union unknown");
      const tagOf = (t: IrType): number => {
        const tag = def.arms.findIndex((a) => typeEquals(a, t));
        if (tag < 0) throw new Error("emitter bug: genResume value union lacks an arm");
        return tag;
      };
      const undefTag = def.arms.findIndex((a) => a.kind === "undefinedT");
      if (undefTag < 0) throw new Error("emitter bug: genResume value union lacks undefined");
      // Lines that leave the wrapped value in `sc_v`, taking OUT's payload.
      const wrapFrom = (srcT: IrType): string[] => {
        if (srcT.kind === "f64") {
          return [`    sc_v = scr_union_new_f64(${tagOf(srcT)}, scr_gen_take_out_f64(sc_g));`];
        }
        if (srcT.kind === "bool") {
          return [`    sc_v = scr_union_new_bool(${tagOf(srcT)}, scr_gen_take_out_bool(sc_g));`];
        }
        if (srcT.kind !== "union") {
          const v = vAdapters(srcT);
          return [
            `    sc_v = scr_union_new_ref(${tagOf(srcT)}, scr_gen_take_out_ref(sc_g), ${v.retain}, ${v.release}, ${E.traceArgC(srcT)});`,
          ];
        }
        // A union channel: OUT holds the union box itself. Identical V
        // passes through; a superset V retags arm-wise (payloads retained
        // through each arm's own adapters, then the source box drops).
        if (typeEquals(srcT, valueT)) {
          return [`    sc_v = (ScrUnion *)scr_gen_take_out_ref(sc_g);`];
        }
        const srcDef = E.unionsById.get(srcT.unionId);
        if (!srcDef) throw new Error("emitter bug: genResume channel union unknown");
        const cases = srcDef.arms.map((arm, i) => {
          const tag = tagOf(arm);
          let build: string;
          if (isUnitType(arm)) {
            build = E.unitInstanceRef(valueT.unionId, tag);
          } else if (arm.kind === "f64") {
            build = `scr_union_new_f64(${tag}, scr_union_get_f64(sc_u))`;
          } else if (arm.kind === "bool") {
            build = `scr_union_new_bool(${tag}, scr_union_get_bool(sc_u))`;
          } else {
            const av = vAdapters(arm);
            build = `scr_union_new_ref(${tag}, ${av.retain}(scr_union_peek(sc_u)), ${av.retain}, ${av.release}, ${E.traceArgC(arm)})`;
          }
          return `    case ${i}: sc_v = ${build}; break;`;
        });
        return [
          `    { ScrUnion *sc_u = (ScrUnion *)scr_gen_take_out_ref(sc_g);`,
          `    switch (sc_u->tag) {`,
          ...cases,
          `    default: sc_v = ${E.unitInstanceRef(valueT.unionId, undefTag)}; break;`,
          `    }`,
          `    scr_union_release(sc_u); }`,
        ];
      };
      const undefLine = `    sc_v = ${E.unitInstanceRef(valueT.unionId, undefTag)};`;
      lines.push(`  ScrUnion *sc_v;`);
      lines.push(`  if (!sc_d) {`);
      // yieldT VOID marks a generator that can never yield (TS's `never`):
      // the suspended branch is unreachable — the undefined arm keeps the
      // C total.
      lines.push(...(genT.yieldT.kind === "void" ? [undefLine] : wrapFrom(genT.yieldT)));
      lines.push(`  } else if (scr_gen_out_has(sc_g)) {`);
      lines.push(...(genT.retT.kind === "void" ? [undefLine] : wrapFrom(genT.retT)));
      lines.push(`  } else {`, undefLine, `  }`);
      lines.push(`  sc_r->${mangleField("value")} = sc_v;`);
    }
    lines.push(`  return sc_r;`, `}`);
    E.walkerProtos.push(`static ${struct} *${sym}(ScrGen *sc_g);`);
    E.walkerDefs.push(...lines, ``);
    return sym;
  }

/** Interned per inner-type resolve thunk for ref-kind new Promise. */
  export function resolveThunkFor(E: CEmitter, inner: IrType): string {
    const key = typeKey(inner);
    let sym = E.resolveThunks.get(key);
    if (!sym) {
      sym = mangleResolveThunk(E.resolveThunks.size);
      E.resolveThunks.set(key, sym);
      const v = vAdapters(inner);
      E.walkerProtos.push(
        `static void ${sym}(ScrClosure *sc_self, ${cDecl(inner, "sc_v")});`,
      );
      E.walkerDefs.push(
        `static void ${sym}(ScrClosure *sc_self, ${cDecl(inner, "sc_v")}) {`,
        `  scr_resolve_ref_impl(sc_self, sc_v, ${v.retain}, ${v.release}, ${E.traceArgC(inner)});`,
        `}`,
      );
    }
    return sym;
  }

/** The EventEmitter listener invoke adapter for one listener signature:
 * `void (ScrClosure *, va_list)` — va_args exactly the listener's own
 * parameter prefix of the emit site's typed tail (the frontend unified
 * the tuple, so reads agree with writes), retains each refcounted value
 * (the callee owns +1 per the universal convention; f64/bool copy), and
 * calls cb->fn behind its exact C signature. Interned per func-type key. */
export function emitterInvokeThunkFor(E: CEmitter, cbT: IrType): string {
  if (cbT.kind !== "func") {
    throw new Error("emitter bug: emitter.on listener not a func (frontend must fence)");
  }
  const key = typeKey(cbT);
  let sym = E.emitterInvokeThunks.get(key);
  if (sym) return sym;
  sym = mangleEmitterInvokeThunk(E.emitterInvokeThunks.size);
  E.emitterInvokeThunks.set(key, sym);
  const reads: string[] = [];
  const passed: string[] = [];
  cbT.params.forEach((p, i) => {
    const name = `sc_a${i}`;
    if (p.kind === "f64" || p.kind === "date") {
      reads.push(`  double ${name} = va_arg(sc_ap, double);`);
      passed.push(name);
    } else if (p.kind === "bool") {
      // bool promotes to int through a variadic call.
      reads.push(`  bool ${name} = (bool)va_arg(sc_ap, int);`);
      passed.push(name);
    } else {
      reads.push(`  ${cDecl(p, name)} = va_arg(sc_ap, ${cType(p).trim()});`);
      passed.push(retainCallC(p, name));
    }
  });
  const sigParams = ["ScrClosure *", ...cbT.params.map((p) => cType(p).trim())].join(", ");
  // The call goes through the listener's TRUE signature; a non-void
  // result is discarded (refcounted ones released) — Node ignores
  // listener return values.
  const retC = cbT.ret.kind === "void" ? "void" : cType(cbT.ret).trim();
  const invoke = `((${retC} (*)(${sigParams}))sc_cb->fn)(${["sc_cb", ...passed].join(", ")})`;
  E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_cb, va_list sc_ap);`);
  E.walkerDefs.push(
    `static void ${sym}(ScrClosure *sc_cb, va_list sc_ap) {`,
    ...(cbT.params.length === 0 ? [`  (void)sc_ap;`] : reads),
    ...(cbT.ret.kind === "void"
      ? [`  ${invoke};`]
      : isRefCounted(cbT.ret)
        ? [`  ${retC} sc_r = ${invoke};`, `  if (sc_r) ${releaseCallC(cbT.ret, "sc_r")};`]
        : [`  (void)${invoke};`]),
    `}`,
    ``,
  );
  return sym;
}

/** The stream completion-callback closure fn for one done func type: the
 * `callback` a user's write/final/destroy/transform/flush receives. The
 * closure's one capture box holds the stream (+1); calling it unwraps the
 * (optional) error/data union arguments and reports completion to the
 * runtime. Kind names the runtime entry: "w" scr_stream_write_done, "f"
 * scr_stream_final_done, "d" scr_stream_destroy_done, "t"
 * scr_stream_transform_done, "l" scr_stream_flush_done. Args arrive
 * callee-owned (+1) per the universal convention and are released here. */
function streamDoneFnFor(E: CEmitter, kind: "w" | "f" | "d" | "t" | "l", doneT: IrType): string {
  if (doneT.kind !== "func") {
    throw new Error("emitter bug: stream done callback not a func (frontend must fence)");
  }
  const key = `${kind}:${typeKey(doneT)}`;
  let sym = E.streamDoneFns.get(key);
  if (sym) return sym;
  sym = mangleStreamDoneFn(E.streamDoneFns.size);
  E.streamDoneFns.set(key, sym);
  const params: string[] = ["ScrClosure *sc_self"];
  const body: string[] = [
    `  ScrStream *sc_s = (ScrStream *)scr_box_get_ref(sc_self->caps[0]); /* +1 */`,
    `  ScrError *sc_err = NULL;`,
  ];
  const errT = doneT.params[0];
  if (errT !== undefined) {
    if (errT.kind !== "union") throw new Error("emitter bug: stream done err param not a union");
    const def = E.unionsById.get(errT.unionId);
    const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
    if (errTag < 0) throw new Error("emitter bug: stream done err union lacks its Error arm");
    params.push("ScrUnion *sc_e");
    body.push(
      `  if (sc_e && sc_e->tag == ${errTag}) sc_err = scr_error_retain((ScrError *)scr_union_peek(sc_e));`,
    );
  }
  const dataLines: string[] = [`  ScrBytes *sc_data = NULL;`, `  ScrStr *sc_dataStr = NULL;`];
  const dataT = doneT.params[1];
  if (kind === "t" || kind === "l") {
    body.push(...dataLines);
    if (dataT !== undefined) {
      if (dataT.kind !== "union") throw new Error("emitter bug: stream done data param not a union");
      const def = E.unionsById.get(dataT.unionId);
      const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes") : -1;
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      params.push("ScrUnion *sc_d");
      body.push(
        ...(bytesTag >= 0
          ? [`  if (sc_d && sc_d->tag == ${bytesTag}) sc_data = scr_bytes_retain((ScrBytes *)scr_union_peek(sc_d));`]
          : []),
        ...(strTag >= 0
          ? [`  if (sc_d && sc_d->tag == ${strTag}) sc_dataStr = scr_str_retain((ScrStr *)scr_union_peek(sc_d));`]
          : []),
      );
    }
  }
  const entry =
    kind === "w" ? "scr_stream_write_done" :
    kind === "f" ? "scr_stream_final_done" :
    kind === "d" ? "scr_stream_destroy_done" :
    kind === "t" ? "scr_stream_transform_done" : "scr_stream_flush_done";
  const tail =
    kind === "t" || kind === "l"
      ? `${entry}(sc_s, sc_err, sc_data, sc_dataStr);`
      : `${entry}(sc_s, sc_err);`;
  E.walkerProtos.push(`static void ${sym}(${params.join(", ")});`);
  E.walkerDefs.push(
    `static void ${sym}(${params.join(", ")}) {`,
    ...body,
    `  ${tail} /* moves sc_err/sc_data; borrows sc_s */`,
    `  scr_stream_release(sc_s);`,
    ...(errT !== undefined ? [`  if (sc_e) scr_union_release(sc_e);`] : []),
    ...((kind === "t" || kind === "l") && dataT !== undefined ? [`  if (sc_d) scr_union_release(sc_d);`] : []),
    `}`,
    ``,
  );
  return sym;
}

/** The stream-'data' listener invoke adapter for one listener func type:
 * the runtime's 'data' emission carries BOTH payload slots (ScrBytes *b,
 * ScrStr *s — exactly one non-NULL; encoded streams deliver strings),
 * and this thunk unwraps the listener's declared side. A listener
 * declaring the WRONG side for the stream's runtime mode gets a clear
 * TypeError instead of a type-confused payload (Node, untyped, would
 * just hand the value over — SEMANTICS.md). Zero-parameter listeners
 * ignore both slots; DYN-parameter listeners (the JS lane's adapter,
 * emitter.onDataDyn) box by tag, which is always right. */
export function streamDataThunkFor(E: CEmitter, cbT: IrType): string {
  if (cbT.kind !== "func") {
    throw new Error("emitter bug: stream data listener not a func (frontend must fence)");
  }
  const key = `data:${typeKey(cbT)}`;
  let sym = E.emitterInvokeThunks.get(key);
  if (sym) return sym;
  sym = mangleEmitterInvokeThunk(E.emitterInvokeThunks.size);
  E.emitterInvokeThunks.set(key, sym);
  const p = cbT.params[0];
  if (cbT.params.length > 1 || (p && p.kind !== "bytes" && p.kind !== "string" && p.kind !== "dyn")) {
    throw new Error("emitter bug: stream data listener param shape (frontend must fence)");
  }
  const body: string[] = [
    `  ScrBytes *sc_b = va_arg(sc_ap, ScrBytes *);`,
    `  ScrStr *sc_s = va_arg(sc_ap, ScrStr *);`,
  ];
  const passed: string[] = ["sc_cb"];
  if (p === undefined) {
    body.push(`  (void)sc_b;`, `  (void)sc_s;`);
  } else if (p.kind === "bytes") {
    body.push(
      `  if (!sc_b) {`,
      `    static const char sc_m[] = "a 'data' listener declaring a Buffer chunk received a string (the stream has an encoding set)";`,
      `    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);`,
      `    return;`,
      `  }`,
    );
    passed.push("scr_bytes_retain(sc_b)");
  } else if (p.kind === "string") {
    body.push(
      `  if (!sc_s) {`,
      `    static const char sc_m[] = "a 'data' listener declaring a string chunk received a Buffer (call setEncoding, or declare the chunk as a Buffer)";`,
      `    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);`,
      `    return;`,
      `  }`,
    );
    passed.push("scr_str_retain(sc_s)");
  } else {
    // dyn: box by runtime tag — the JS lane's adapter parameter.
    body.push(`  ScrDyn *sc_d = sc_b ? scr_dyn_new_buffer_copy(sc_b) : scr_dyn_new_str(sc_s);`);
    passed.push("sc_d");
  }
  const sigParams = ["ScrClosure *", ...cbT.params.map((q) => cType(q).trim())].join(", ");
  const retC = cbT.ret.kind === "void" ? "void" : cType(cbT.ret).trim();
  const invoke = `((${retC} (*)(${sigParams}))sc_cb->fn)(${passed.join(", ")})`;
  E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_cb, va_list sc_ap);`);
  E.walkerDefs.push(
    `static void ${sym}(ScrClosure *sc_cb, va_list sc_ap) {`,
    ...body,
    ...(cbT.ret.kind === "void"
      ? [`  ${invoke};`]
      : isRefCounted(cbT.ret)
        ? [`  ${retC} sc_r = ${invoke};`, `  if (sc_r) ${releaseCallC(cbT.ret, "sc_r")};`]
        : [`  (void)${invoke};`]),
    `}`,
    ``,
  );
  return sym;
}

/** The stream option-callback invoke adapter for one (kind, callback
 * type): the runtime calls the user's read/write/final/destroy/transform/
 * flush closure through it. The stream rides first (the leading `this`
 * param every option callback's lifted fn takes); the user may have
 * declared any PREFIX of the Node signature, so the adapter passes
 * exactly the declared prefix (retaining each ref per the callee-owns
 * convention) and materializes the completion-callback closure only when
 * declared — an undeclared completion callback means the operation can
 * never complete, exactly Node. Kinds: "r" read(size), "w" write(chunk,
 * enc, cb), "f" final(cb), "d" destroy(err, cb), "t" transform(chunk,
 * enc, cb), "l" flush(cb). */
export function streamCbThunkFor(E: CEmitter, kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string {
  if (cbT.kind !== "func") {
    throw new Error("emitter bug: stream option callback not a func (frontend must fence)");
  }
  const key = `${kind}:${typeKey(cbT)}`;
  let sym = E.streamCbThunks.get(key);
  if (sym) return sym;
  sym = mangleStreamCbThunk(E.streamCbThunks.size);
  E.streamCbThunks.set(key, sym);
  // The runtime-facing C signatures, per kind.
  const runtimeParams =
    kind === "r" ? ["ScrStream *sc_s", "double sc_size"] :
    kind === "w" || kind === "t" ? ["ScrStream *sc_s", "ScrBytes *sc_chunk"] :
    kind === "d" || kind === "e" ? ["ScrStream *sc_s", "ScrError *sc_err"] :
    ["ScrStream *sc_s"];
  // The user callback's declared prefix: params[0] is the stream (`this`)
  // for the inline forms; a THISLESS callback (the checked-dynamic VALUE
  // adapter — its first param is dyn, never an object) takes the Node
  // positions from param 0 and never receives the stream (the dyn call
  // ABI carries no receiver; SEMANTICS.md).
  const declared = cbT.params;
  const hasThis = declared[0] !== undefined && declared[0].kind === "object";
  if (declared.length === 0) {
    throw new Error("emitter bug: stream option callback with no params (frontend must fence)");
  }
  const passed: string[] = hasThis
    ? ["sc_cb", `(${cType(declared[0]!).trim()})scr_stream_retain(sc_s)`]
    : ["sc_cb"];
  const body: string[] = [];
  const off = hasThis ? 1 : 0;
  const full = (kind === "r" ? 1 : kind === "w" || kind === "t" ? 3 : kind === "d" ? 2 : 1) + off;
  // "e" (the finished/pipeline callback): ONE Node position — the error.
  if (declared.length > full) {
    throw new Error(`emitter bug: stream '${kind}' callback declares ${declared.length} params (frontend must fence)`);
  }
  for (let i = off; i < declared.length; i++) {
    const p = declared[i]!;
    const pos = i - off; // 0-based Node signature position
    if (kind === "r") {
      // read(size) — a dyn-declared size (the JS lane) boxes the number.
      passed.push(p.kind === "dyn" ? "scr_dyn_new_num(sc_size)" : "sc_size");
      continue;
    }
    const isChunkPos = (kind === "w" || kind === "t") && pos === 0;
    const isEncPos = (kind === "w" || kind === "t") && pos === 1;
    const isErrPos = (kind === "d" || kind === "e") && pos === 0;
    const isDonePos =
      kind === "e" ? false
      : (kind === "w" || kind === "t") ? pos === 2 : (kind === "f" || kind === "l") ? pos === 0 : pos === 1;
    // The JS lane's implicitly-any parameters: each position boxes into
    // dyn by kind — the chunk as dyn bytes, the encoding as a string,
    // the error as the boundary's {name, message} shape (null when
    // none), and the completion callback as a CALLABLE dyn whose glue
    // dispatches to the runtime's *_done entry (the closure's one cap
    // boxes the retained stream).
    if (p.kind === "dyn") {
      if (isChunkPos) {
        passed.push(`scr_dyn_new_buffer_copy(sc_chunk)`);
      } else if (isEncPos) {
        body.push(
          `  ScrStr *sc_encs = scr_str_new("buffer", 6);`,
          `  ScrDyn *sc_encd = scr_dyn_new_str(sc_encs);`,
          `  scr_str_release(sc_encs);`,
        );
        passed.push(`sc_encd`);
      } else if (isErrPos) {
        // finished/pipeline succeed with UNDEFINED (Node calls the eos
        // callback with no arguments); destroy passes null.
        passed.push(kind === "e"
          ? `sc_err ? scr_dyn_from_error(sc_err) : scr_dyn_retain(scr_dyn_undefined())`
          : `sc_err ? scr_dyn_from_error(sc_err) : scr_dyn_new_null()`);
      } else if (isDonePos) {
        const glue = `scr_stream_done_dyn_${kind}`;
        body.push(
          `  ScrClosure *sc_dclo = scr_closure_new((void *)&${glue}, 1);`,
          `  sc_dclo->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);`,
          `  scr_box_set_ref(sc_dclo->caps[0], scr_stream_retain(sc_s));`,
          `  ScrDyn *sc_done = scr_dyn_new_func(sc_dclo, &${glue}, ${kind === "t" || kind === "l" ? 2 : 1}, ${JSON.stringify(kind === "t" || kind === "l" ? "(error,data)" : "(error)")}, "callback");`,
        );
        passed.push(`sc_done`);
      } else {
        throw new Error(`emitter bug: stream '${kind}' dyn callback param ${i} has no adapter`);
      }
      continue;
    }
    if (isChunkPos) {
      passed.push(`scr_bytes_retain(sc_chunk)`);
    } else if (isEncPos) {
      // Node's encoding for decoded (Buffer) chunks is 'buffer'.
      body.push(`  ScrStr *sc_enc = scr_str_new("buffer", 6);`);
      passed.push(`sc_enc`);
    } else if (isErrPos) {
      // destroy's error argument: `Error | null` — wrap type-directedly.
      // The finished/pipeline callback ("e") may declare `Error | null |
      // undefined` (the @types signature); success prefers the undefined
      // arm there (Node calls the eos callback with NO arguments).
      if (p.kind !== "union") throw new Error("emitter bug: stream destroy err param not a union");
      const def = E.unionsById.get(p.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      const undefTag = kind === "e" && def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
      const nullTag = def
        ? (undefTag >= 0 ? undefTag : def.arms.findIndex((a) => a.kind === "nullT"))
        : -1;
      if (errTag < 0 || nullTag < 0) throw new Error("emitter bug: stream destroy err union lacks its arms");
      body.push(
        `  ScrUnion *sc_eu = sc_err ? scr_union_new_ref(${errTag}, scr_error_retain(sc_err), &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg()) : scr_union_retain(${E.unitInstanceRef(p.unionId, nullTag)});`,
      );
      passed.push(`sc_eu`);
    } else if (isDonePos) {
      const doneKind = kind as "w" | "f" | "d" | "t" | "l"; // "e" has no done position
      const doneFn = streamDoneFnFor(E, doneKind, p);
      body.push(
        `  ScrClosure *sc_done = scr_closure_new((void *)&${doneFn}, 1);`,
        `  sc_done->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);`,
        `  scr_box_set_ref(sc_done->caps[0], scr_stream_retain(sc_s));`,
      );
      passed.push(`sc_done`);
    } else {
      throw new Error(`emitter bug: stream '${kind}' callback param ${i} has no adapter`);
    }
  }
  const sigParams = ["ScrClosure *", ...declared.map((p) => cType(p).trim())].join(", ");
  const unused: string[] = [];
  if (declared.length < off + 1) {
    if (kind === "r") unused.push(`  (void)sc_size;`);
    if (kind === "w" || kind === "t") unused.push(`  (void)sc_chunk;`);
    if (kind === "d" || kind === "e") unused.push(`  (void)sc_err;`);
  }
  if (!hasThis) unused.push(`  (void)sc_s;`); /* the done/err adapters may still read it */
  // The call goes through the callback's TRUE signature; a non-void
  // result is discarded (refcounted ones released) — Node ignores option
  // callback results (`read: () => this.push(null)`).
  const retC = cbT.ret.kind === "void" ? "void" : cType(cbT.ret).trim();
  const invoke = `((${retC} (*)(${sigParams}))sc_cb->fn)(${passed.join(", ")})`;
  E.walkerProtos.push(`static void ${sym}(ScrClosure *sc_cb, ${runtimeParams.join(", ")});`);
  E.walkerDefs.push(
    `static void ${sym}(ScrClosure *sc_cb, ${runtimeParams.join(", ")}) {`,
    ...unused,
    ...body,
    ...(cbT.ret.kind === "void"
      ? [`  ${invoke};`]
      : isRefCounted(cbT.ret)
        ? [`  ${retC} sc_r = ${invoke};`, `  if (sc_r) ${releaseCallC(cbT.ret, "sc_r")};`]
        : [`  (void)${invoke};`]),
    `}`,
    ``,
  );
  return sym;
}
