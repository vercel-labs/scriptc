/* Island-boundary C emission owned pieces: the embedded npm module/edge
 * tables (--dynamic builds embed every reached npm source; the island's
 * module loader and require shim read them — binaries never touch
 * node_modules at runtime) and the interned host-call adapters that let the
 * engine invoke scriptc closures. */
import { deflateRawSync } from "node:zlib";
import type { CEmitter } from "./emitter.js";
import { cDecl, cFnPtrCast, cStringLiteral, releaseCallC } from "./emit-types.js";
import { IrType, islandCallbackRet, NPM_COMPRESS_MIN, typeKey } from "../../ir/nodes.js";

/** Embedded npm modules (--dynamic): every reached module's SOURCE as a
 * static string plus the resolution edges — the island's module loader
 * and require shim read these tables; binaries never touch node_modules
 * at runtime. Registered with the runtime at the top of main.
 *
 * Module text at least NPM_COMPRESS_MIN long stores as raw DEFLATE when
 * that shrinks it (JS deflates 3-4×; a big CLI graph is tens of MB of
 * text, THE dominant binary-size term). The table row carries the
 * inflated length beside the stored one, and the island's loader inflates
 * LAZILY at a module's first load through the inflater the emitted main
 * installs (scr_island_set_inflate ← scr_zlib_inflate_exact; index.ts
 * links scr_zlib.c/libz on the same moduleEmbedsCompressedNpm predicate),
 * so boot touches no compressed page a run never loads — cold start
 * SHRINKS with the binary. */
export function emitNpmEmbedding(E: CEmitter, out: string[]): void {
  const embedded = E.mod.embedded;
  if (embedded && embedded.modules.length > 0) {
    const emitChunked = (name: string, bytes: Buffer, comment?: string): void => {
      out.push(`static const char ${name}[] = ${comment !== undefined ? `/* ${comment} */` : ""}`);
      for (let off = 0; off < bytes.length; off += 2048) {
        const last = off + 2048 >= bytes.length;
        out.push(`    ${cStringLiteral(bytes.subarray(off, off + 2048))}${last ? ";" : ""}`);
      }
      if (bytes.length === 0) out.push(`    "";`);
    };
    // text → {bytes to store, raw: 0 for plain | the inflated length}.
    // The candidate test is moduleEmbedsCompressedNpm's, by construction.
    const store = (text: string): { bytes: Buffer; raw: number } => {
      const plain = Buffer.from(text, "utf8");
      if (text.length < NPM_COMPRESS_MIN) return { bytes: plain, raw: 0 };
      const deflated = deflateRawSync(plain, { level: 9 });
      return deflated.length < plain.length
        ? { bytes: deflated, raw: plain.length }
        : { bytes: plain, raw: 0 };
    };
    const stored = embedded.modules.map((m) => ({
      src: store(m.source),
      esm: m.esm !== undefined ? store(m.esm) : null,
    }));
    stored.forEach((s, i) => {
      const m = embedded.modules[i]!;
      emitChunked(`sc_npm_src_${i}`, s.src.bytes, m.key.split("/node_modules/").pop());
      // CJS modules carry their synthesized ESM facade (default plus the
      // export names LEXED at build time, matching Node's vendored CJS
      // lexer): the island loader evaluates it when an ES module imports
      // the file.
      if (s.esm !== null) emitChunked(`sc_npm_esm_${i}`, s.esm.bytes);
    });
    const fmt = { esm: 0, cjs: 1, json: 2 } as const;
    out.push(`static const ScrIslandModule sc_npm_modules[] = {`);
    stored.forEach((s, i) => {
      const m = embedded.modules[i]!;
      const facade =
        s.esm !== null
          ? `sc_npm_esm_${i}, sizeof sc_npm_esm_${i} - 1, ${s.esm.raw}`
          : `NULL, 0, 0`;
      const typeless =
        m.typelessPackageJson !== undefined && m.typelessWarning !== undefined
          ? `${cStringLiteral(Buffer.from(m.typelessPackageJson, "utf8"))}, ` +
            `${cStringLiteral(Buffer.from(m.typelessWarning, "utf8"))}`
          : `NULL, NULL`;
      out.push(
        `  { ${cStringLiteral(Buffer.from(m.key, "utf8"))}, sc_npm_src_${i}, ` +
          `sizeof sc_npm_src_${i} - 1, ${s.src.raw}, ${fmt[m.format]}, ${facade}, ${typeless} },`,
      );
    });
    out.push(`};`);
    if (embedded.edges.length > 0) {
      // kind: 0 = any call form, 1 = import-resolved, 2 = require-resolved
      // (a dual package's condition split — the loader looks edges up with
      // its call form's kind).
      const kindOf = { any: 0, import: 1, require: 2 } as const;
      out.push(`static const ScrIslandEdge sc_npm_edges[] = {`);
      for (const e of embedded.edges) {
        const s = (t: string) => cStringLiteral(Buffer.from(t, "utf8"));
        out.push(`  { ${s(e.from)}, ${s(e.specifier)}, ${s(e.to)}, ${kindOf[e.kind]} },`);
      }
      out.push(`};`);
    }
    out.push("");
  }
}

/** The host-call adapter for closures of a given (arity, return kind) —
   * see islandAdapters. `argv` cells are BORROWED by the wrapper; the
   * closure ABI consumes (+1) each param, so the adapter retains them in.
   * A jsval-returning closure's +1 result passes straight through;
   * primitive returns marshal back by value; void closures return NULL
   * (the wrapper turns that into `undefined`). */
  export function islandAdapter(E: CEmitter, arity: number, retKind: "void" | "jsval" | "f64" | "bool" | "string"): string {
    const tag = { void: "v", jsval: "j", f64: "f", bool: "b", string: "s" }[retKind];
    const key = `${arity}:${tag}`;
    const existing = E.islandAdapters.get(key);
    if (existing) return existing;
    const name = `sc_ia_${arity}${tag}`;
    E.islandAdapters.set(key, name);
    const cRet = { void: "void", jsval: "ScrJsval *", f64: "double", bool: "bool", string: "ScrStr *" }[retKind];
    const params = ["ScrClosure *"].concat(Array<string>(arity).fill("ScrJsval *"));
    const callArgs = ["c", ...Array.from({ length: arity }, (_, i) => `scr_jsval_retain(argv[${i}])`)];
    const call = `((Fn)c->fn)(${callArgs.join(", ")})`;
    const body =
      retKind === "void"
        ? [`  ${call};`, `  return NULL;`]
        : retKind === "jsval"
          ? [`  return ${call};`]
          : retKind === "f64"
            ? [`  return scr_jsval_from_f64(${call});`]
            : retKind === "bool"
              ? [`  return scr_jsval_from_bool(${call});`]
              : [
                  // The closure's +1 string marshals in, then releases.
                  // NULL is the throw-path dummy — the wrapper sees the
                  // pending exception and reverse-bridges it.
                  `  ScrStr *s = ${call};`,
                  `  if (!s) return NULL;`,
                  `  ScrJsval *r = scr_jsval_from_str(s);`,
                  `  scr_str_release(s);`,
                  `  return r;`,
                ];
    const sig = `static ScrJsval *${name}(ScrClosure *c, ScrJsval **argv)`;
    E.walkerProtos.push(
      `${sig}; /* island host-call adapter (${arity} arg${arity === 1 ? "" : "s"}, ${retKind}) */`,
    );
    E.walkerDefs.push(
      `${sig} {`,
      `  typedef ${cRet} (*Fn)(${params.join(", ")});`,
      ...(arity === 0 ? [`  (void)argv;`] : []),
      ...body,
      `}`,
    );
    return name;
  }

/** The host-call adapter for a closure with TYPED parameters — one per
   * full signature (param typeKeys + return classification), interned like
   * the all-'any' adapters above. On invocation from the engine, each
   * BORROWED argv cell converts to its param's static type through the
   * EXISTING exit machinery: strict primitive exits, JSON round-trip
   * composites via the dynCheck walker (width-tolerant records, path-
   * annotated failures), a `T | undefined` param taking the interned
   * undefined arm when the argument is absent or undefined (the engine
   * wrapper pads missing args with undefined and drops surplus — JS call
   * semantics), and jsval params passing through as retained handles. A
   * conversion failure releases what was already built and returns NULL
   * with the exception pending — the wrapper reverse-bridges it into the
   * island as a TypeError, so a lying engine argument throws instead of
   * corrupting memory (the boundary's trust-but-verify rule). Converted
   * params are CONSUMED by the closure ABI (+1 each moves in). Sync
   * returns marshal back like the all-'any' adapters; a Promise return
   * (async callbacks) wraps as an engine promise settled when the scriptc
   * promise settles (scr_jsval_from_promise). */
  export function islandTypedAdapter(E: CEmitter, fn: IrType & { kind: "func" }): string {
    const ret = islandCallbackRet(fn.ret, (id) => E.recordsById.get(id), (id) => E.unionsById.get(id));
    if (!ret) throw new Error("emitter bug: typed island adapter with unsupported return");
    const key = `${fn.params.map((p) => typeKey(p)).join(",")}=>${ret.async ? "P:" : ""}${ret.tag}`;
    const existing = E.islandTypedAdapters.get(key);
    if (existing) return existing;
    const name = `sc_ita_${E.islandTypedAdapters.size}`;
    E.islandTypedAdapters.set(key, name);
    const decls: string[] = [];
    const conv: string[] = [];
    const cleanup: string[] = [];
    let canFail = false;
    fn.params.forEach((p, i) => {
      const a = `sc_a${i}`;
      switch (p.kind) {
        case "jsval":
          decls.push(`  ScrJsval *${a} = NULL;`);
          conv.push(`  ${a} = scr_jsval_retain(argv[${i}]);`);
          cleanup.push(`  scr_jsval_release(${a});`);
          break;
        case "f64":
          canFail = true;
          decls.push(`  double ${a} = 0;`);
          conv.push(`  if (!scr_jsval_exit_f64(argv[${i}], &${a})) goto sc_convfail;`);
          break;
        case "bool":
          canFail = true;
          decls.push(`  bool ${a} = false;`);
          conv.push(`  if (!scr_jsval_exit_bool(argv[${i}], &${a})) goto sc_convfail;`);
          break;
        case "string":
          canFail = true;
          decls.push(`  ScrStr *${a} = NULL;`);
          conv.push(`  ${a} = scr_jsval_exit_str(argv[${i}]);`, `  if (!${a}) goto sc_convfail;`);
          cleanup.push(`  scr_str_release(${a});`);
          break;
        default: {
          // Composite (record/array/union): the jsExit pipeline — engine
          // JSON.stringify, json.parse, the interned dynCheck builder.
          canFail = true;
          const utag = E.undefinedArmTag(p);
          decls.push(`  ${cDecl(p, a)} = NULL;`);
          const roundTrip = [
            `    ScrStr *sc_j = scr_jsval_to_json(argv[${i}]);`,
            `    if (!sc_j) goto sc_convfail;`,
            `    ScrDyn *sc_d = scr_json_parse(sc_j);`,
            `    scr_str_release(sc_j);`,
            `    if (!sc_d) goto sc_convfail;`,
            `    ${a} = ${E.dynCheckHelper(p)}(sc_d, NULL);`,
            `    scr_dyn_release(sc_d);`,
            `    if (scr_exc_pending()) goto sc_convfail;`,
          ];
          if (p.kind === "union" && utag >= 0) {
            conv.push(
              `  if (scr_jsval_is_undefined(argv[${i}])) {`,
              `    ${a} = ${E.unitInstanceRef(p.unionId, utag)}; /* absent/undefined argument -> the undefined arm */`,
              `  } else {`,
              ...roundTrip,
              `  }`,
            );
          } else {
            conv.push(`  {`, ...roundTrip, `  }`);
          }
          cleanup.push(`  ${releaseCallC(p, a)};`);
        }
      }
    });
    const call = `(${cFnPtrCast(fn)}c->fn)(${["c", ...fn.params.map((_, i) => `sc_a${i}`)].join(", ")})`;
    const body: string[] = [];
    if (ret.async) {
      // The closure returns a +1 ScrPromise (async bodies spawn eagerly to
      // the first suspension and return it; a sync body building a promise
      // may throw instead — NULL dummy with the exception pending, which
      // the wrapper bridges). from_promise takes ownership.
      const tagC = {
        void: "SCR_ISLP_VOID", f64: "SCR_ISLP_F64", bool: "SCR_ISLP_BOOL",
        string: "SCR_ISLP_STR", jsval: "SCR_ISLP_JSVAL",
        json: "", dyn: "", // unreachable: islandCallbackRet never tags async json/dyn
      }[ret.tag];
      body.push(
        `  ScrPromise *sc_r = ${call};`,
        `  if (!sc_r) return NULL;`,
        `  return scr_jsval_from_promise(sc_r, ${tagC});`,
      );
    } else {
      switch (ret.tag) {
        case "void":
          body.push(`  ${call};`, `  return NULL;`);
          break;
        case "jsval":
          body.push(`  return ${call};`);
          break;
        case "f64":
          body.push(`  return scr_jsval_from_f64(${call});`);
          break;
        case "bool":
          body.push(`  return scr_jsval_from_bool(${call});`);
          break;
        case "string":
          body.push(
            // The closure's +1 string marshals in, then releases. NULL is
            // the throw-path dummy — the wrapper bridges the pending
            // exception.
            `  ScrStr *sc_s = ${call};`,
            `  if (!sc_s) return NULL;`,
            `  ScrJsval *sc_r = scr_jsval_from_str(sc_s);`,
            `  scr_str_release(sc_s);`,
            `  return sc_r;`,
          );
          break;
        case "dyn":
          body.push(
            // A checked-dynamic (+1 dyn) result: deep copy into the
            // engine (the jsMarshal dyn rule — data kinds only; boxed
            // functions/handles leave the exception pending and the NULL
            // dummy bridges).
            `  ScrDyn *sc_d = ${call};`,
            `  if (!sc_d) return NULL;`,
            `  ScrJsval *sc_r = scr_jsval_from_dyn(sc_d);`,
            `  scr_dyn_release(sc_d);`,
            `  return sc_r;`,
          );
          break;
        case "json": {
          // A JSON-safe composite return: the jsMarshal path — the
          // type-directed serializer, then the engine's JSON parser (deep
          // copy; the documented aliasing divergence). NULL result is the
          // throw-path dummy.
          const helper = E.jsonWriteHelper(fn.ret);
          body.push(
            `  ${cDecl(fn.ret, "sc_rv")} = ${call};`,
            `  if (scr_exc_pending()) { ${releaseCallC(fn.ret, "sc_rv")}; return NULL; }`,
            `  ScrJsonBuf sc_jb; scr_jb_init(&sc_jb);`,
            `  ${helper}(&sc_jb, sc_rv);`,
            `  ${releaseCallC(fn.ret, "sc_rv")};`,
            `  ScrStr *sc_rj = scr_jb_finish(&sc_jb);`,
            `  ScrJsval *sc_r = scr_jsval_from_json(sc_rj);`,
            `  scr_str_release(sc_rj);`,
            `  return sc_r;`,
          );
          break;
        }
      }
    }
    const fail = canFail
      ? [
          `sc_convfail:`,
          // Params already converted release here (NULL-tolerant; unit-arm
          // instances are immortal — their release is a no-op); the ones
          // never reached are still NULL/scalar. The pending TypeError
          // reverse-bridges in the wrapper.
          ...cleanup,
          `  return NULL;`,
        ]
      : [];
    const sig = `static ScrJsval *${name}(ScrClosure *c, ScrJsval **argv)`;
    E.walkerProtos.push(`${sig}; /* typed island host-call adapter: ${key} */`);
    E.walkerDefs.push(
      `${sig} { /* ${key} */`,
      ...(fn.params.length === 0 ? [`  (void)argv;`] : []),
      ...decls,
      ...conv,
      ...body,
      ...fail,
      `}`,
      ``,
    );
    return name;
  }
