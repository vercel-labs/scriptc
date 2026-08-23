import { InternalCompilerError } from "../../errors.js";
/* Structure-walking helper EMITTERS: interned per-type C helper functions
 * for JSON serialization, dyn matching/validation (dynCheck), dyn value
 * descriptions, and whole-union truthiness/equality. Each helper is emitted
 * once per type shape and cached in the emitter's registries (jsonWriters,
 * dynMatchers, dynBuilders, unionTruthyFns, unionEqFns, walkerProtos/Defs) —
 * interning ORDER is part of the emitted C, so the registries stay on
 * CEmitter and these functions only consult them through it. */
import type { CEmitter } from "./emitter.js";
import { DYN_HANDLE_KINDS, IrType, isRefCounted, typeEquals, typeKey } from "../../ir/nodes.js";
import { dynDesc, undefinedArmTag } from "../../ir/analysis.js";
import { cDecl, cStringLiteral, cType, elemAccess, releaseCallC, retainCallC, vAdapters } from "./emit-types.js";
import { mangleField, mangleRecordNew, mangleRecordStruct } from "../mangle.js";
import { OVERFLOW_MEMBER } from "./emit-shapes.js";

/** The per-union ToBoolean helper (interned per unionId): switch on the
   * runtime tag — unit arms false, f64 arms 0/NaN-falsy, string arms
   * empty-falsy, bool arms by payload, ref arms always true (JS objects),
   * jsval arms answered by the engine. Borrows the operand. */
  export function unionTruthyHelper(E: CEmitter, unionId: string): string {
    const existing = E.unionTruthyFns.get(unionId);
    if (existing) return existing;
    const def = E.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`emitter bug: truthiness of unknown union ${unionId}`);
    const name = `sc_ut_${E.unionTruthyFns.size}`;
    E.unionTruthyFns.set(unionId, name);
    const sig = `static bool ${name}(ScrUnion *v)`;
    E.walkerProtos.push(`${sig}; /* ToBoolean ${unionId} */`);
    const d: string[] = [`${sig} { /* ToBoolean ${unionId} */`, `  switch (v->tag) {`];
    def.arms.forEach((arm, i) => {
      switch (arm.kind) {
        case "undefinedT":
        case "nullT":
          d.push(`  case ${i}: return false;`);
          break;
        case "f64":
          d.push(`  case ${i}: { double x = scr_union_get_f64(v); return x == x && x != 0; }`);
          break;
        case "bool":
          d.push(`  case ${i}: return scr_union_get_bool(v);`);
          break;
        case "string":
          d.push(`  case ${i}: return ((ScrStr *)scr_union_peek(v))->len != 0;`);
          break;
        case "jsval":
          d.push(`  case ${i}: return scr_jsval_truthy((ScrJsval *)scr_union_peek(v)) != 0;`);
          break;
        default:
          // Arrays, maps, sets, records, objects, functions, promises,
          // regexes, ...: JS objects are always truthy — [] and {} included.
          d.push(`  case ${i}: return true; /* ${arm.kind} */`);
      }
    });
    d.push(
      `  default: scr_trap("scriptc: internal error: invalid union tag\\n");`,
      `  }`,
      `}`,
      ``,
    );
    E.walkerDefs.push(...d);
    return name;
  }

/** The per-union strict-equality helper (interned per unionId, with a
   * separate SameValue variant per unionId when Object.is reaches it):
   * different tags are never equal; equal tags compare the arm values —
   * unit arms equal, f64 with C == (NaN !== NaN, +0 === -0) or SameValue
   * (NaN equals NaN, +0 differs from -0) under the sameValue flag,
   * strings by bytes, bools by value, ref arms by POINTER identity (JS
   * object equality). Borrows both operands. */
  export function unionEqHelper(E: CEmitter, unionId: string, sameValue: boolean): string {
    const key = sameValue ? `sv:${unionId}` : unionId;
    const existing = E.unionEqFns.get(key);
    if (existing) return existing;
    const def = E.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`emitter bug: equality of unknown union ${unionId}`);
    const name = `sc_ue_${E.unionEqFns.size}`;
    E.unionEqFns.set(key, name);
    const what = sameValue ? "SameValue" : "strict equality";
    const sig = `static bool ${name}(ScrUnion *a, ScrUnion *b)`;
    E.walkerProtos.push(`${sig}; /* ${what} ${unionId} */`);
    const d: string[] = [
      `${sig} { /* ${what} ${unionId} */`,
      `  if (a->tag != b->tag) return false;`,
      `  switch (a->tag) {`,
    ];
    def.arms.forEach((arm, i) => {
      switch (arm.kind) {
        case "undefinedT":
        case "nullT":
          d.push(`  case ${i}: return true;`);
          break;
        case "f64":
          d.push(
            sameValue
              ? `  case ${i}: return scr_num_same_value(scr_union_get_f64(a), scr_union_get_f64(b));`
              : `  case ${i}: return scr_union_get_f64(a) == scr_union_get_f64(b);`,
          );
          break;
        case "bool":
          d.push(`  case ${i}: return scr_union_get_bool(a) == scr_union_get_bool(b);`);
          break;
        case "string":
          d.push(
            `  case ${i}: return scr_str_eq((ScrStr *)scr_union_peek(a), (ScrStr *)scr_union_peek(b));`,
          );
          break;
        default:
          // Ref arms: pointer identity, exactly JS object equality.
          d.push(`  case ${i}: return scr_union_peek(a) == scr_union_peek(b); /* ${arm.kind} */`);
      }
    });
    d.push(
      `  default: scr_trap("scriptc: internal error: invalid union tag\\n");`,
      `  }`,
      `}`,
      ``,
    );
    E.walkerDefs.push(...d);
    return name;
  }

/** The per-union ToString helper (interned per unionId): switch on the
   * runtime tag — unit arms return the interned "undefined"/"null" texts,
   * string arms retain the payload, f64/bool arms go through the JS-exact
   * formatters (String(x) semantics). Ref arms never arrive (the frontend
   * fences unions with object arms from string conversion — JS would print
   * "[object Object]"). Borrows the operand; the result is owned (+1). */
  export function unionToStrHelper(E: CEmitter, unionId: string): string {
    const existing = E.unionToStrFns.get(unionId);
    if (existing) return existing;
    const def = E.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`emitter bug: ToString of unknown union ${unionId}`);
    const name = `sc_us_${E.unionToStrFns.size}`;
    E.unionToStrFns.set(unionId, name);
    const sig = `static ScrStr *${name}(ScrUnion *v)`;
    E.walkerProtos.push(`${sig}; /* ToString ${unionId} */`);
    const d: string[] = [`${sig} { /* ToString ${unionId} */`, `  switch (v->tag) {`];
    def.arms.forEach((arm, i) => {
      switch (arm.kind) {
        case "undefinedT":
        case "nullT": {
          const lit = E.internLiteral(arm.kind === "undefinedT" ? "undefined" : "null");
          d.push(`  case ${i}: return scr_str_retain((ScrStr *)&${lit});`);
          break;
        }
        case "string":
          d.push(`  case ${i}: return scr_str_retain((ScrStr *)scr_union_peek(v));`);
          break;
        case "f64":
          d.push(`  case ${i}: return scr_f64_to_scrstr(scr_union_get_f64(v));`);
          break;
        case "bool":
          d.push(`  case ${i}: return scr_bool_to_scrstr(scr_union_get_bool(v));`);
          break;
        case "bytes": {
          // Buffer.toString() IS the utf8 decode (Node's default
          // encoding) — the `Buffer | string` chunk idiom.
          const enc = E.internLiteral("utf8");
          d.push(`  case ${i}: return scr_bytes_to_str((ScrBytes *)scr_union_peek(v), (ScrStr *)&${enc});`);
          break;
        }
        default:
          throw new InternalCompilerError(`emitter bug: ToString of union with a ${arm.kind} arm (frontend fences these)`);
      }
    });
    d.push(
      `  default: scr_trap("scriptc: internal error: invalid union tag\\n");`,
      `  }`,
      `}`,
      ``,
    );
    E.walkerDefs.push(...d);
    return name;
  }

/** The per-union array-join helper (interned per unionId): Array.prototype
   * .join over union elements — undefined/null arms print EMPTY (exactly
   * JS's join, which silences only the nullish elements), every other arm
   * goes through the per-union ToString walker (string arms verbatim,
   * f64/bool via the JS-exact formatters). The frontend admits only unions
   * of f64/string/bool/unit arms here. Borrows the array and separator;
   * the result is owned (+1). */
  export function unionJoinHelper(E: CEmitter, unionId: string): string {
    const existing = E.unionJoinFns.get(unionId);
    if (existing) return existing;
    const def = E.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`emitter bug: join of unknown union ${unionId}`);
    const name = `sc_uj_${E.unionJoinFns.size}`;
    E.unionJoinFns.set(unionId, name);
    const toStr = unionToStrHelper(E, unionId);
    const unitTags = def.arms.flatMap((a, i) =>
      a.kind === "undefinedT" || a.kind === "nullT" ? [i] : [],
    );
    const sig = `static ScrStr *${name}(ScrArr *a, ScrStr *sep)`;
    E.walkerProtos.push(`${sig}; /* join ${unionId} */`);
    E.walkerDefs.push(
      `${sig} { /* Array#join over ${unionId}: nullish arms print empty */`,
      `  ScrJsonBuf b;`,
      `  scr_jb_init(&b);`,
      `  size_t n = (size_t)scr_arr_len(a);`,
      `  for (size_t i = 0; i < n; i++) {`,
      `    if (i) for (size_t j = 0; j < sep->len; j++) scr_jb_putc(&b, sep->data[j]);`,
      `    ScrUnion *u = (ScrUnion *)scr_arr_get_ref(a, (double)i);`,
      ...(unitTags.length > 0
        ? [`    if (${unitTags.map((t) => `u->tag == ${t}`).join(" || ")}) { scr_union_release(u); continue; }`]
        : []),
      `    ScrStr *s = ${toStr}(u);`,
      `    for (size_t j = 0; j < s->len; j++) scr_jb_putc(&b, s->data[j]);`,
      `    scr_str_release(s);`,
      `    scr_union_release(u);`,
      `  }`,
      `  return scr_jb_finish(&b);`,
      `}`,
      ``,
    );
    return name;
  }

/** The dyn ToString helper pair (interned once, type-independent):
   * Node's String() over a dyn value — "undefined"/"null" texts, bools,
   * JS-exact number formatting (NaN/Infinity spelled out — NOT the JSON
   * null), strings verbatim, arrays via Array.prototype.toString (join
   * with ","; null/undefined ELEMENTS print empty, nested arrays flatten
   * through the recursion — JS-exact), plain objects as
   * "[object Object]". The operand is borrowed; the result is owned (+1). */
  export function dynToStrHelper(E: CEmitter): string {
    if (E.dynToStrFn) return E.dynToStrFn;
    const name = "sc_ds";
    E.dynToStrFn = name;
    E.walkerProtos.push(
      `static void ${name}_buf(ScrJsonBuf *b, const ScrDyn *d); /* String(unknown) walker */`,
      `static ScrStr *${name}(const ScrDyn *d); /* String(unknown) */`,
    );
    E.walkerDefs.push(
      `static void ${name}_buf(ScrJsonBuf *b, const ScrDyn *d) { /* String(unknown), recursive */`,
      `  switch (d->kind) {`,
      `  case SCR_DYN_UNDEF: scr_jb_puts(b, "undefined"); break;`,
      `  case SCR_DYN_NULL: scr_jb_puts(b, "null"); break;`,
      `  case SCR_DYN_BOOL: scr_jb_puts(b, d->v.b ? "true" : "false"); break;`,
      `  case SCR_DYN_NUM: {`,
      `    ScrStr *s = scr_f64_to_scrstr(d->v.num); /* String(n): NaN/Infinity spelled out, not JSON null */`,
      `    for (size_t i = 0; i < s->len; i++) scr_jb_putc(b, s->data[i]);`,
      `    scr_str_release(s);`,
      `    break;`,
      `  }`,
      `  case SCR_DYN_STR:`,
      `    for (size_t i = 0; i < d->v.str->len; i++) scr_jb_putc(b, d->v.str->data[i]);`,
      `    break;`,
      `  case SCR_DYN_ARR:`,
      `    /* Array.prototype.toString: join(",") — null/undefined ELEMENTS`,
      `     * print empty (unlike top level), nested arrays flatten. */`,
      `    for (size_t i = 0; i < d->v.arr.len; i++) {`,
      `      if (i > 0) scr_jb_putc(b, ',');`,
      `      const ScrDyn *e = d->v.arr.items[i];`,
      `      if (e->kind == SCR_DYN_UNDEF || e->kind == SCR_DYN_NULL) continue;`,
      `      ${name}_buf(b, e);`,
      `    }`,
      `    break;`,
      `  case SCR_DYN_OBJ:`,
      `    if (scr_dyn_obj_get(d, "%error", 6)) {`,
      `      /* The checked-dynamic tree's error encoding (caughtToDyn): Error.prototype`,
      `       * .toString over the encoded name/message — Node's String(err),`,
      `       * which carries no stack either. */`,
      `      const ScrDyn *en = scr_dyn_obj_get(d, "name", 4);`,
      `      const ScrDyn *em = scr_dyn_obj_get(d, "message", 7);`,
      `      const ScrStr *ens = (en && en->kind == SCR_DYN_STR) ? en->v.str : NULL;`,
      `      const ScrStr *ems = (em && em->kind == SCR_DYN_STR) ? em->v.str : NULL;`,
      `      if (ens) for (size_t i = 0; i < ens->len; i++) scr_jb_putc(b, ens->data[i]);`,
      `      if (ens && ens->len && ems && ems->len) scr_jb_puts(b, ": ");`,
      `      if (ems) for (size_t i = 0; i < ems->len; i++) scr_jb_putc(b, ems->data[i]);`,
      `      break;`,
      `    }`,
      `    scr_jb_puts(b, "[object Object]");`,
      `    break;`,
      `  case SCR_DYN_BYTES: {`,
      `    /* Buffer-flavored values (stream chunks) coerce utf8 (Node's`,
      `     * Buffer.toString); plain Uint8Array joins its elements. */`,
      `    if (d->buffer) {`,
      `      ScrStr *enc = scr_str_new("utf8", 4);`,
      `      ScrStr *txt = scr_bytes_to_str(d->v.bytes, enc);`,
      `      scr_str_release(enc);`,
      `      for (size_t i = 0; i < txt->len; i++) scr_jb_putc(b, txt->data[i]);`,
      `      scr_str_release(txt);`,
      `      break;`,
      `    }`,
      `    for (size_t i = 0; i < d->v.bytes->len; i++) {`,
      `      if (i > 0) scr_jb_putc(b, ',');`,
      `      char n[16];`,
      `      snprintf(n, sizeof n, "%u", (unsigned)d->v.bytes->data[i]);`,
      `      scr_jb_puts(b, n);`,
      `    }`,
      `    break;`,
      `  }`,
      `  case SCR_DYN_FUNC:`,
      `    /* Function.prototype.toString: the SOURCE is gone in a compiled`,
      `     * program, so the native-code form — exactly what JS engines`,
      `     * print for their own non-JS functions. */`,
      `    scr_jb_puts(b, "function ");`,
      `    if (d->v.fn.name) scr_jb_puts(b, d->v.fn.name);`,
      `    scr_jb_puts(b, "() { [native code] }");`,
      `    break;`,
      `  case SCR_DYN_HANDLE:`,
      `    /* Object.prototype.toString — Node's String() over these`,
      `     * classes (IncomingMessage/ServerResponse/Socket). */`,
      `    scr_jb_puts(b, "[object Object]");`,
      `    break;`,
      `  case SCR_DYN_PROMISE:`,
      `    /* Object.prototype.toString with the Promise @@toStringTag. */`,
      `    scr_jb_puts(b, "[object Promise]");`,
      `    break;`,
      `  case SCR_DYN_JSVAL:`,
      `    /* Island-held: the engine's own ToString (a bridged failure`,
      `     * leaves the exception pending and appends nothing). */`,
      `    scr_dyn_isl_tostr_buf(b, d);`,
      `    break;`,
      `  case SCR_DYN_TYPED_REF: {`,
      `    ScrDyn *sc_materialized = scr_dyn_typed_ref_materialize(d);`,
      `    ${name}_buf(b, sc_materialized);`,
      `    scr_dyn_release(sc_materialized);`,
      `    break;`,
      `  }`,
      `  }`,
      `}`,
      `static ScrStr *${name}(const ScrDyn *d) { /* String(unknown) -> owned (+1) */`,
      `  if (d->kind == SCR_DYN_STR) return scr_str_retain(d->v.str);`,
      `  ScrJsonBuf b;`,
      `  scr_jb_init(&b);`,
      `  ${name}_buf(&b, d);`,
      `  return scr_jb_finish(&b);`,
      `}`,
      ``,
    );
    return name;
  }

/** The caught→dyn converter (interned once, type-independent): a catch
   * binding flowing into an `unknown` slot — the typed→unknown deep-copy
   * stance over the exception snapshot's runtime kind. Scalar payloads
   * convert exactly; an Error-family OBJ payload becomes the checked-dynamic tree's error
   * encoding — the reserved "%error" marker plus name/message (and code
   * when stamped), so `instanceof Error`, the %Error extraction, and
   * String() answer like Node; every other payload (REF — records, arrays,
   * closures, unions — and non-Error hierarchy objects, type-erased at
   * runtime) becomes an EMPTY dyn object (SEMANTICS.md 67). Borrows the
   * snapshot; the result is a fresh tree (+1). Never throws. */
  export function caughtToDynHelper(E: CEmitter): string {
    if (E.caughtToDynFn) return E.caughtToDynFn;
    const name = "sc_cd";
    E.caughtToDynFn = name;
    const sig = `static ScrDyn *${name}(const ScrCaught *c)`;
    E.walkerProtos.push(`${sig}; /* caught -> unknown */`);
    E.walkerDefs.push(
      `${sig} { /* caught -> unknown (+1, fresh tree) */`,
      `  switch (c->kind) {`,
      `  case SCR_EXC_F64: return scr_dyn_new_num(c->f64);`,
      `  case SCR_EXC_BOOL: return scr_dyn_new_bool(c->b);`,
      `  case SCR_EXC_STR: return scr_dyn_new_str((ScrStr *)c->payload); /* _new_str retains */`,
      `  case SCR_EXC_OBJ:`,
      `    if (scr_error_is(c->payload)) {`,
      `      /* The identity-cached crossing (scr_json.c): the SAME error`,
      `       * instance boxes to ONE dyn node however it crosses, so a`,
      `       * caught dyn compares reference-equal to the thrown error's`,
      `       * other boxings, like Node. */`,
      `      return scr_dyn_from_error((const ScrError *)c->payload);`,
      `    }`,
      `    /* FALLTHROUGH: a non-Error hierarchy object is type-erased */`,
      `  case SCR_EXC_REF:`,
      `    /* A thrown dyn value passes back BY REFERENCE (identity with`,
      `     * every other holder of the node — the traced-throw shape). */`,
      `    if (c->retain_fn == scr_dyn_retain_v) return scr_dyn_retain((ScrDyn *)c->payload);`,
      `    /* FALLTHROUGH */`,
      `  default:`,
      `    /* non-dyn REF and non-Error objects: the "[object Object]"`,
      `     * approximation — truthy, typeof "object", fields unreadable. */`,
      `    return scr_dyn_new_obj();`,
      `  }`,
      `}`,
      ``,
    );
    return name;
  }

/** The pretty-print re-indenter (interned once, type-independent):
   * `JSON.stringify(v, null, space)` output as a REWRITE of the compact
   * serializer text — Node's gap algorithm exactly. Structural '{'/'[' open
   * a newline + one-deeper indent (unless immediately closed: `{}` and `[]`
   * stay inline, like Node), '}'/']' close onto their own line at the outer
   * depth, ',' breaks the line at the current depth, and the key ':' gains
   * one space. String state (with escape skipping) keeps literal braces,
   * commas, and colons inside JSON strings untouched. Compact input is
   * BORROWED; the result is a fresh string (+1). An empty indent (space 0,
   * "", null) never reaches here — the frontend drops the property. */
  export function jsonIndentHelper(E: CEmitter): string {
    if (E.jsonIndentFn) return E.jsonIndentFn;
    const name = "sc_ji";
    E.jsonIndentFn = name;
    const sig = `static ScrStr *${name}(ScrStr *compact, const char *indent, size_t ilen)`;
    E.walkerProtos.push(`${sig}; /* stringify space re-indent */`);
    E.walkerDefs.push(
      `${sig} { /* stringify space re-indent (Node's gap algorithm) */`,
      `  ScrJsonBuf b;`,
      `  scr_jb_init(&b);`,
      `  const char *s = compact->data;`,
      `  size_t n = compact->len;`,
      `  size_t depth = 0;`,
      `  bool instr = false;`,
      `#define SCR_JI_INDENT() do { \\`,
      `    scr_jb_putc(&b, '\\n'); \\`,
      `    for (size_t td = 0; td < depth; td++) \\`,
      `      for (size_t tk = 0; tk < ilen; tk++) scr_jb_putc(&b, indent[tk]); \\`,
      `  } while (0)`,
      `  for (size_t i = 0; i < n; i++) {`,
      `    char c = s[i];`,
      `    if (instr) {`,
      `      scr_jb_putc(&b, c);`,
      `      if (c == '\\\\' && i + 1 < n) { scr_jb_putc(&b, s[++i]); }`,
      `      else if (c == '"') instr = false;`,
      `      continue;`,
      `    }`,
      `    switch (c) {`,
      `    case '"': instr = true; scr_jb_putc(&b, c); break;`,
      `    case '{': case '[':`,
      `      scr_jb_putc(&b, c);`,
      `      if (i + 1 < n && s[i + 1] == (c == '{' ? '}' : ']')) {`,
      `        scr_jb_putc(&b, s[++i]); /* empty {} / [] stay inline, like Node */`,
      `        break;`,
      `      }`,
      `      depth++;`,
      `      SCR_JI_INDENT();`,
      `      break;`,
      `    case '}': case ']':`,
      `      depth--;`,
      `      SCR_JI_INDENT();`,
      `      scr_jb_putc(&b, c);`,
      `      break;`,
      `    case ',':`,
      `      scr_jb_putc(&b, ',');`,
      `      SCR_JI_INDENT();`,
      `      break;`,
      `    case ':':`,
      `      scr_jb_putc(&b, ':');`,
      `      scr_jb_putc(&b, ' ');`,
      `      break;`,
      `    default:`,
      `      scr_jb_putc(&b, c);`,
      `    }`,
      `  }`,
      `#undef SCR_JI_INDENT`,
      `  return scr_jb_finish(&b);`,
      `}`,
      ``,
    );
    return name;
  }

export function jsonWriteHelper(E: CEmitter, t: IrType): string {
    const key = typeKey(t);
    const existing = E.jsonWriters.get(key);
    if (existing) return existing;
    const name = `sc_jw_${E.jsonWriters.size}`;
    E.jsonWriters.set(key, name);
    const sig = `static void ${name}(ScrJsonBuf *b, ${cDecl(t, "v")})`;
    E.walkerProtos.push(`${sig}; /* stringify ${key} */`);
    const d: string[] = [`${sig} { /* stringify ${key} */`];
    switch (t.kind) {
      case "f64":
        d.push(`  scr_jb_put_f64(b, v); /* NaN/Infinity -> null, -0 -> 0, like JS */`);
        break;
      case "bool":
        d.push(`  scr_jb_puts(b, v ? "true" : "false");`);
        break;
      case "string":
        d.push(`  scr_jb_put_json_str(b, v);`);
        break;
      case "record": {
        const shape = E.recordsById.get(t.shapeId);
        if (!shape) throw new InternalCompilerError(`emitter bug: jsonStringify of unknown shape ${t.shapeId}`);
        // CYCLE-CAPABLE shapes (recursive record types — the collector-
        // fixpoint set) bracket the walk with the circular-detection
        // stack: a value already being serialized above throws V8's exact
        // circular-structure TypeError (scr_jb_enter). Edge labels stamp
        // only before members whose walk can re-enter (cycle-capable
        // types); acyclic shapes pay nothing.
        const cyclic = E.traceAdapterC(t) !== null;
        const edgeable = (ft: IrType): boolean => cyclic && E.traceAdapterC(ft) !== null;
        if (cyclic) d.push(`  if (!scr_jb_enter(b, v, ${shape.tuple ? "true" : "false"})) return; /* circular: pending TypeError */`);
        // A tuple serializes as a JSON ARRAY in index order — JS-exact
        // (JSON.stringify(["a", 1]) is `["a",1]`). Every position is
        // required, so labels/commas are static like all-required records.
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          d.push(`  scr_jb_putc(b, '[');`);
          byIndex.forEach((f, i) => {
            if (i > 0) d.push(`  scr_jb_putc(b, ',');`);
            if (edgeable(f.type)) d.push(`  scr_jb_edge_idx(b, ${i});`);
            d.push(`  ${E.jsonWriteHelper(f.type)}(b, v->${mangleField(f.name)});`);
          });
          d.push(`  scr_jb_putc(b, ']');`);
          if (cyclic) d.push(`  scr_jb_leave(b);`);
          break;
        }
        // Fields serialize in DECLARED order — JS insertion order, exactly
        // Node for objects constructed in declaration order (SEMANTICS.md
        // 36 documents the divergence when they are not) — never the
        // canonical (sorted) struct order. declaredOrder may omit internal
        // '%'-fields (Dirent's %dtype): those are hidden from JSON exactly
        // like every other key-order surface. Shapes interned WITHOUT an
        // order (the CJS export-table literal, accessor-narrowed JS
        // shapes) keep the canonical order — their construction paths
        // document the divergence.
        const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
        const inOrder = new Set(order);
        if (shape.fields.some((f) => !inOrder.has(f.name) && !f.name.startsWith("%"))) {
          throw new InternalCompilerError(`emitter bug: declaredOrder of shape ${t.shapeId} omits a non-internal field`);
        }
        const byName = new Map(shape.fields.map((f) => [f.name, f]));
        const emitFields = order.map((n) => byName.get(n)).filter((f) => f !== undefined);
        // Optional-flavored fields (undefined-armed unions) DROP from the
        // output while they hold the undefined arm — exactly Node — so as
        // soon as one exists, comma placement turns dynamic (a `first`
        // flag); all-required shapes keep the static prefix labels. An
        // overflow portion forces the dynamic path too (entry count is
        // runtime state).
        const droppable =
          emitFields.some((f) => undefinedArmTag(f.type, E.unionsById) >= 0) || !!shape.indexValue;
        d.push(`  scr_jb_putc(b, '{');`);
        if (!droppable) {
          emitFields.forEach((f, i) => {
            const label = cStringLiteral(Buffer.from(`${i > 0 ? "," : ""}"${f.name}":`, "utf8"));
            d.push(`  scr_jb_puts(b, ${label});`);
            if (edgeable(f.type)) d.push(`  scr_jb_edge_prop(b, ${cStringLiteral(Buffer.from(f.name, "utf8"))});`);
            // Refcounted fields are BORROWED straight off the struct (the
            // record itself is borrowed for the whole call).
            d.push(`  ${E.jsonWriteHelper(f.type)}(b, v->${mangleField(f.name)});`);
          });
        } else {
          d.push(`  bool first = true;`);
          for (const f of emitFields) {
            const label = cStringLiteral(Buffer.from(`"${f.name}":`, "utf8"));
            const utag = undefinedArmTag(f.type, E.unionsById);
            const pad = utag >= 0 ? "    " : "  ";
            if (utag >= 0) {
              d.push(`  if (v->${mangleField(f.name)}->tag != ${utag}) { /* undefined-valued field: dropped, like Node */`);
            }
            d.push(`${pad}if (!first) scr_jb_putc(b, ',');`);
            d.push(`${pad}first = false;`);
            d.push(`${pad}scr_jb_puts(b, ${label});`);
            if (edgeable(f.type)) d.push(`${pad}scr_jb_edge_prop(b, ${cStringLiteral(Buffer.from(f.name, "utf8"))});`);
            d.push(`${pad}${E.jsonWriteHelper(f.type)}(b, v->${mangleField(f.name)});`);
            if (utag >= 0) d.push(`  }`);
          }
          // Overflow entries follow the declared fields, themselves in JS
          // OWN-KEY order — integer-like keys ascending first, then the
          // rest in insertion order (scr_map_keys_js_order, the same
          // enumeration Object.keys answers; number-keyed signatures make
          // integer-like overflow keys ordinary). SEMANTICS.md documents
          // the declared-canonical-then-overflow divergence from JS's one
          // interleaved key order. Keys escape like any JSON string;
          // undefined-valued entries drop, exactly the optional-field rule.
          if (shape.indexValue) {
            const iv = shape.indexValue;
            const m = `v->${OVERFLOW_MEMBER}`;
            d.push(`  {`);
            d.push(`    ScrArr *ks = scr_map_keys_js_order(${m});`);
            d.push(`    for (size_t i = 0; i < ks->len; i++) {`);
            d.push(`      ScrStr *k = (ScrStr *)scr_arr_get_ref(ks, (double)i);`);
            if (iv.kind === "f64" || iv.kind === "bool") {
              d.push(`      ${cDecl(iv, "e")} = 0;`);
              d.push(`      scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(${m}, k, &e);`);
            } else {
              d.push(`      ${cDecl(iv, "e")} = (${cType(iv).trim()})scr_map_get_str_ref(${m}, k);`);
            }
            const skipUndef =
              iv.kind === "dyn"
                ? `e->kind == SCR_DYN_UNDEF`
                : undefinedArmTag(iv, E.unionsById) >= 0
                  ? `e->tag == ${undefinedArmTag(iv, E.unionsById)}`
                  : null;
            if (skipUndef) {
              d.push(`      if (${skipUndef}) { /* undefined-valued entry: dropped, like Node */`);
              d.push(`        ${releaseCallC(iv, "e")};`);
              d.push(`        scr_str_release(k);`);
              d.push(`        continue;`);
              d.push(`      }`);
            }
            d.push(`      if (!first) scr_jb_putc(b, ',');`);
            d.push(`      first = false;`);
            d.push(`      scr_jb_put_json_str(b, k);`);
            d.push(`      scr_jb_putc(b, ':');`);
            if (edgeable(iv)) d.push(`      scr_jb_edge_key(b, k);`);
            d.push(`      ${E.jsonWriteHelper(iv)}(b, e);`);
            d.push(`      scr_str_release(k);`);
            if (isRefCounted(iv)) d.push(`      ${releaseCallC(iv, "e")};`);
            d.push(`    }`);
            d.push(`    scr_arr_release(ks);`);
            d.push(`  }`);
          }
        }
        d.push(`  scr_jb_putc(b, '}');`);
        if (cyclic) d.push(`  scr_jb_leave(b);`);
        break;
      }
      case "dyn":
        // Overflow values under an `unknown` index signature: the checked-dynamic tree
        // serializes itself (runtime walker) — object members holding
        // undefined drop, array slots holding undefined print null,
        // exactly Node. Bare JSON.stringify of dyn stays frontend-fenced;
        // this writer is reachable only through overflow entries.
        d.push(`  scr_jb_put_dyn(b, v);`);
        break;
      case "array": {
        const elem = t.elem;
        const w = E.jsonWriteHelper(elem);
        // A cycle-capable array (elements can point back at it) joins the
        // circular-detection stack exactly like a cycle-capable record.
        const cyclic = E.traceAdapterC(t) !== null;
        if (cyclic) d.push(`  if (!scr_jb_enter(b, v, true)) return; /* circular: pending TypeError */`);
        d.push(`  scr_jb_putc(b, '[');`);
        d.push(`  for (size_t i = 0; i < v->len; i++) {`);
        d.push(`    if (i > 0) scr_jb_putc(b, ',');`);
        if (cyclic) d.push(`    scr_jb_edge_idx(b, i);`);
        if (elem.kind === "f64") {
          d.push(`    ${w}(b, scr_arr_get_f64(v, (double)i));`);
        } else if (elem.kind === "bool") {
          d.push(`    ${w}(b, scr_arr_get_bool(v, (double)i));`);
        } else {
          // _get_ref returns +1; release after writing.
          d.push(`    ${cDecl(elem, "e")} = (${cType(elem).trim()})scr_arr_get_ref(v, (double)i);`);
          d.push(`    ${w}(b, e);`);
          d.push(`    ${releaseCallC(elem, "e")};`);
        }
        d.push(`  }`);
        d.push(`  scr_jb_putc(b, ']');`);
        if (cyclic) d.push(`  scr_jb_leave(b);`);
        break;
      }
      case "union": {
        const def = E.unionsById.get(t.unionId);
        if (!def) throw new InternalCompilerError(`emitter bug: jsonStringify of unknown union ${t.unionId}`);
        d.push(`  switch (v->tag) {`);
        def.arms.forEach((arm, i) => {
          if (arm.kind === "nullT") {
            // Payload-less arm: JSON.stringify(null) is the text `null`,
            // exactly like Node.
            d.push(`  case ${i}: scr_jb_puts(b, "null"); break;`);
            return;
          }
          if (arm.kind === "undefinedT") {
            // Reachable only as a record FIELD's serializer (bare
            // undefined-armed unions are fenced from stringify), and the
            // record writer drops the field while it holds this tag before
            // calling — so the tag can never arrive here.
            d.push(`  case ${i}: /* undefined arm: the field dropped at the record level */`);
            d.push(`    scr_trap("scriptc: internal error: stringify reached an undefined arm\\n");`);
            return;
          }
          const w = E.jsonWriteHelper(arm);
          if (arm.kind === "f64") {
            d.push(`  case ${i}: ${w}(b, scr_union_get_f64(v)); break;`);
          } else if (arm.kind === "bool") {
            d.push(`  case ${i}: ${w}(b, scr_union_get_bool(v)); break;`);
          } else {
            // Payload is BORROWED out of the box for the write.
            d.push(`  case ${i}: ${w}(b, (${cType(arm).trim()})scr_union_peek(v)); break;`);
          }
        });
        d.push(`  default: scr_trap("scriptc: internal error: invalid union tag\\n");`);
        d.push(`  }`);
        break;
      }
      default:
        throw new InternalCompilerError(`emitter bug: jsonStringify of non-JSON type ${t.kind}`);
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The emitted match predicate for one dynCheck target type:
   * `static bool sc_dm_<n>(const ScrDyn *d)` — does this dyn fit T?
   * Never throws, builds nothing; union builders use it to try arms in
   * canonical order (first FULL match wins). Records are width-tolerant
   * here too: extra keys are ignored, only declared fields are examined. */
  export function dynMatchHelper(E: CEmitter, t: IrType): string {
    const key = typeKey(t);
    const existing = E.dynMatchers.get(key);
    if (existing) return existing;
    const name = `sc_dm_${E.dynMatchers.size}`;
    E.dynMatchers.set(key, name);
    const sig = `static bool ${name}(const ScrDyn *d)`;
    E.walkerProtos.push(`${sig}; /* matches ${key} */`);
    const d: string[] = [`${sig} { /* matches ${key} */`];
    if (isRefCounted(t) && t.kind !== "dyn") {
      const keyLit = cStringLiteral(Buffer.from(key, "utf8"));
      d.push(
        `  if (scr_dyn_typed_ref_is(d, ${keyLit}, ${Buffer.byteLength(key, "utf8")})) return true;`,
      );
    }
    if (t.kind !== "dyn") {
      d.push(
        `  if (d && d->kind == SCR_DYN_TYPED_REF) {`,
        `    ScrDyn *sc_materialized = scr_dyn_typed_ref_materialize(d);`,
        `    bool sc_out = ${name}(sc_materialized);`,
        `    scr_dyn_release(sc_materialized);`,
        `    return sc_out;`,
        `  }`,
      );
    }
    switch (t.kind) {
      case "f64":
        d.push(`  return d->kind == SCR_DYN_NUM;`);
        break;
      case "string":
        d.push(`  return d->kind == SCR_DYN_STR;`);
        break;
      case "bool":
        d.push(`  return d->kind == SCR_DYN_BOOL;`);
        break;
      case "nullT":
        // JSON null matches exactly the nullT arm (reachable only as a
        // union-arm matcher — bare null is not a valid dynCheck target).
        d.push(`  return d->kind == SCR_DYN_NULL;`);
        break;
      case "undefinedT":
        // JSON text never parses to undefined, but the checked-dynamic tree can HOLD it now
        // (overflow reads/conversions under `unknown` index signatures):
        // the undefined dyn value matches exactly the undefined arm.
        d.push(`  return d->kind == SCR_DYN_UNDEF;`);
        break;
      case "dyn":
        // An `unknown` target: every dyn value fits, undefined included.
        d.push(`  (void)d;`);
        d.push(`  return true;`);
        break;
      case "bytes":
        // A Uint8Array target (the checked-dynamic tree carries u8 payloads only).
        if (t.elem !== "u8") throw new InternalCompilerError(`emitter bug: dynMatch of bytes<${t.elem}>`);
        d.push(`  return d->kind == SCR_DYN_BYTES;`);
        break;
      case "record": {
        const shape = E.recordsById.get(t.shapeId);
        if (!shape) throw new InternalCompilerError(`emitter bug: dynCheck of unknown shape ${t.shapeId}`);
        // A tuple matches a JSON ARRAY of EXACTLY its arity whose elements
        // match positionally (arity is part of the type — width tolerance
        // is an object-key concept and does not apply).
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          d.push(`  if (d->kind != SCR_DYN_ARR || d->v.arr.len != ${byIndex.length}) return false;`);
          byIndex.forEach((f, i) => {
            d.push(`  if (!${E.dynMatchHelper(f.type)}(d->v.arr.items[${i}])) return false;`);
          });
          d.push(`  return true;`);
          break;
        }
        d.push(`  if (d->kind != SCR_DYN_OBJ) return false;`);
        // dyn ('unknown') fields match ANY value, present or missing (a
        // missing key builds the undefined dyn value) — no test to emit.
        if (shape.fields.some((f) => f.type.kind !== "dyn")) d.push(`  const ScrDyn *m;`);
        for (const f of shape.fields) {
          if (f.type.kind === "dyn") continue;
          const keyLit = cStringLiteral(Buffer.from(f.name, "utf8"));
          const keyLen = Buffer.byteLength(f.name, "utf8");
          d.push(`  m = scr_dyn_obj_get(d, ${keyLit}, ${keyLen});`);
          if (undefinedArmTag(f.type, E.unionsById) >= 0) {
            // Optional-flavored field: a MISSING key is the undefined arm
            // (a match); a PRESENT key must fit the union as usual.
            d.push(`  if (m && !${E.dynMatchHelper(f.type)}(m)) return false;`);
          } else {
            d.push(`  if (!m || !${E.dynMatchHelper(f.type)}(m)) return false;`);
          }
        }
        // Index-signature shapes: UNDECLARED keys must fit the overflow
        // value type (the builder CAPTURES them — width tolerance became
        // width capture). A dyn value type accepts anything; concrete
        // types check every extra entry.
        if (shape.indexValue && shape.indexValue.kind !== "dyn") {
          const skip = shape.fields
            .map((f) => {
              const keyLit = cStringLiteral(Buffer.from(f.name, "utf8"));
              const keyLen = Buffer.byteLength(f.name, "utf8");
              return `(e->key_len == ${keyLen} && memcmp(e->key, ${keyLit}, ${keyLen}) == 0)`;
            })
            .join(" || ");
          d.push(`  for (size_t i = 0; i < d->v.obj.len; i++) {`);
          d.push(`    const ScrDynEntry *e = &d->v.obj.entries[i];`);
          if (shape.fields.length > 0) d.push(`    if (${skip}) continue;`);
          d.push(`    if (!${E.dynMatchHelper(shape.indexValue)}(e->value)) return false;`);
          d.push(`  }`);
        }
        d.push(`  return true;`);
        break;
      }
      case "array": {
        const m = E.dynMatchHelper(t.elem);
        d.push(`  if (d->kind != SCR_DYN_ARR) return false;`);
        d.push(`  for (size_t i = 0; i < d->v.arr.len; i++) {`);
        d.push(`    if (!${m}(d->v.arr.items[i])) return false;`);
        d.push(`  }`);
        d.push(`  return true;`);
        break;
      }
      case "union": {
        const def = E.unionsById.get(t.unionId);
        if (!def) throw new InternalCompilerError(`emitter bug: dynCheck of unknown union ${t.unionId}`);
        // The undefined arm participates: parsed JSON never contains
        // undefined (a MISSING record key was the arm's only source), but
        // the checked-dynamic tree can hold the undefined value now — overflow entries
        // under `unknown` index signatures — and it matches exactly the
        // undefined arm.
        const arms = def.arms.map((a) => `${E.dynMatchHelper(a)}(d)`);
        d.push(`  return ${arms.join(" || ")};`);
        break;
      }
      default:
        throw new InternalCompilerError(`emitter bug: dynMatch of non-JSON type ${t.kind}`);
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The emitted keyed read on a dyn value:
   * `static ScrDyn *sc_dyn_key_get(ScrDyn *d, ScrStr *k, bool opt)` —
   * OBJ answers the member (+1) or the undefined singleton (own-property
   * answer); ARR answers `length` and canonical in-range indices, STR
   * answers `length` (UTF-16-exact via scr_str_utf16_len), both
   * undefined otherwise; NUM/BOOL/BYTES answer undefined. undefined/null
   * receivers THROW the catchable Node-shaped TypeError, or answer the
   * undefined singleton when `opt` is set (a `?.` step). Borrows d and k;
   * the result is +1. Interned once (the memo key can never collide with
   * a typeKey — no IR type spells "%"). */
  /** RequireObjectCoercible with V8's destructuring TypeError (the
   * dynDestrCheck node): nullish throws "Cannot destructure 'SPELL' as it
   * is undefined." (or "…null."), the property form "Cannot destructure
   * property 'PROP' of 'SPELL' …" when firstProp is non-NULL — V8's exact
   * strings, source spelling included. Non-nullish values pass silently. */
  export function dynDestrCheckHelper(E: CEmitter): string {
    const memoKey = "%dynDestrCheck";
    const existing = E.dynBuilders.get(memoKey);
    if (existing) return existing;
    const name = "sc_dyn_destr_check";
    E.dynBuilders.set(memoKey, name);
    const sig = `static void ${name}(const ScrDyn *d, const char *spell, const char *firstProp)`;
    E.walkerProtos.push(`${sig}; /* destructuring RequireObjectCoercible */`);
    E.walkerDefs.push(
      `${sig} { /* destructuring RequireObjectCoercible */`,
      `  if (d->kind != SCR_DYN_UNDEF && d->kind != SCR_DYN_NULL) return;`,
      `  ScrJsonBuf b;`,
      `  scr_jb_init(&b);`,
      `  if (firstProp) {`,
      `    scr_jb_puts(&b, "Cannot destructure property '");`,
      `    scr_jb_puts(&b, firstProp);`,
      `    scr_jb_puts(&b, "' of '");`,
      `    scr_jb_puts(&b, spell);`,
      `    scr_jb_puts(&b, "' as it is ");`,
      `  } else {`,
      `    scr_jb_puts(&b, "Cannot destructure '");`,
      `    scr_jb_puts(&b, spell);`,
      `    scr_jb_puts(&b, "' as it is ");`,
      `  }`,
      `  scr_jb_puts(&b, d->kind == SCR_DYN_UNDEF ? "undefined." : "null.");`,
      `  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));`,
      `}`,
      ``,
    );
    return name;
  }

  /** GetIterator + first-N steps over a dyn value (the dynIterN node), as
   * array destructuring sees it: arrays step by index, strings by CODE
   * POINT (the string iterator — astral chars arrive unsplit), Buffers by
   * byte; everything else throws V8's exact not-iterable TypeError
   * ("undefined is not iterable …", "object null is not iterable …",
   * "number 1 is not iterable …", "boolean true …", "object …",
   * "function …" — each with the "(cannot read property
   * Symbol(Symbol.iterator))" tail). Returns a fresh +1 dyn array of
   * exactly n elements, undefined-padded past the end. */
  export function dynIterNHelper(E: CEmitter): string {
    const memoKey = "%dynIterN";
    const existing = E.dynBuilders.get(memoKey);
    if (existing) return existing;
    const name = "sc_dyn_iter_n";
    E.dynBuilders.set(memoKey, name);
    const sig = `static ScrDyn *${name}(const ScrDyn *d, size_t n)`;
    E.walkerProtos.push(`${sig}; /* destructuring GetIterator + N steps */`);
    E.walkerDefs.push(
      `${sig} { /* destructuring GetIterator + N steps */`,
      `  if (d->kind == SCR_DYN_TYPED_REF) {`,
      `    ScrDyn *sc_materialized = scr_dyn_typed_ref_materialize(d);`,
      `    ScrDyn *sc_out = ${name}(sc_materialized, n);`,
      `    scr_dyn_release(sc_materialized);`,
      `    return sc_out;`,
      `  }`,
      `  if (d->kind == SCR_DYN_JSVAL) {`,
      `    /* An engine array IS iterable — the not-iterable TypeError below`,
      `     * would be a wrong claim. Loud fence (lane dyn-routing-ops). */`,
      `    scr_dyn_isl_fence(d, "iteration");`,
      `    return NULL;`,
      `  }`,
      `  if (d->kind != SCR_DYN_ARR && d->kind != SCR_DYN_STR && d->kind != SCR_DYN_BYTES) {`,
      `    ScrJsonBuf b;`,
      `    scr_jb_init(&b);`,
      `    switch (d->kind) {`,
      `    case SCR_DYN_UNDEF: scr_jb_puts(&b, "undefined"); break;`,
      `    case SCR_DYN_NULL: scr_jb_puts(&b, "object null"); break;`,
      `    case SCR_DYN_BOOL: scr_jb_puts(&b, d->v.b ? "boolean true" : "boolean false"); break;`,
      `    case SCR_DYN_NUM: {`,
      `      scr_jb_puts(&b, "number ");`,
      `      ScrStr *s = scr_f64_to_scrstr(d->v.num);`,
      `      for (size_t i = 0; i < s->len; i++) scr_jb_putc(&b, s->data[i]);`,
      `      scr_str_release(s);`,
      `      break;`,
      `    }`,
      `    case SCR_DYN_FUNC: scr_jb_puts(&b, "function"); break;`,
      `    default: scr_jb_puts(&b, "object"); break;`,
      `    }`,
      `    scr_jb_puts(&b, " is not iterable (cannot read property Symbol(Symbol.iterator))");`,
      `    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));`,
      `    return NULL;`,
      `  }`,
      `  ScrDyn *out = scr_dyn_new_arr();`,
      `  for (size_t i = 0; i < n; i++) {`,
      `    ScrDyn *item = NULL;`,
      `    if (d->kind == SCR_DYN_ARR) {`,
      `      item = i < d->v.arr.len ? scr_dyn_retain(d->v.arr.items[i]) : scr_dyn_retain(scr_dyn_undefined());`,
      `    } else if (d->kind == SCR_DYN_BYTES) {`,
      `      item = i < d->v.bytes->len ? scr_dyn_new_num((double)d->v.bytes->data[i]) : scr_dyn_retain(scr_dyn_undefined());`,
      `    } else {`,
      `      /* String iteration: whole code POINTS (astral chars arrive`,
      `       * unsplit — the string iterator, not charAt). */`,
      `      double len = scr_str_utf16_len(d->v.str);`,
      `      double at = 0;`,
      `      for (size_t step = 0; step < i && at < len; step++) {`,
      `        ScrStr *cp = scr_str_cp_at(d->v.str, at);`,
      `        at += scr_str_utf16_len(cp);`,
      `        scr_str_release(cp);`,
      `      }`,
      `      if (at < len) {`,
      `        ScrStr *cp = scr_str_cp_at(d->v.str, at);`,
      `        item = scr_dyn_new_str(cp);`,
      `        scr_str_release(cp);`,
      `      } else {`,
      `        item = scr_dyn_retain(scr_dyn_undefined());`,
      `      }`,
      `    }`,
      `    scr_dyn_arr_push(out, item); /* push takes ownership */`,
      `  }`,
      `  return out;`,
      `}`,
      ``,
    );
    return name;
  }

  export function dynKeyGetHelper(E: CEmitter): string {
    const memoKey = "%dynKeyGet";
    const existing = E.dynBuilders.get(memoKey);
    if (existing) return existing;
    const name = "sc_dyn_key_get";
    E.dynBuilders.set(memoKey, name);
    const sig = `static ScrDyn *${name}(ScrDyn *d, ScrStr *k, bool opt)`;
    E.walkerProtos.push(`${sig}; /* d[k] on dyn */`);
    const d: string[] = [`${sig} { /* d[k] on dyn */`];
    d.push(`  if (d->kind == SCR_DYN_UNDEF || d->kind == SCR_DYN_NULL) {`);
    d.push(`    if (opt) return scr_dyn_retain(scr_dyn_undefined());`);
    d.push(`    const char *base = d->kind == SCR_DYN_UNDEF`);
    d.push(`      ? "Cannot read properties of undefined (reading '"`);
    d.push(`      : "Cannot read properties of null (reading '";`);
    d.push(`    ScrStr *head = scr_str_new(base, strlen(base));`);
    d.push(`    ScrStr *withKey = scr_str_concat(head, k);`);
    d.push(`    scr_str_release(head);`);
    d.push(`    ScrStr *tail = scr_str_new("')", 2);`);
    d.push(`    ScrStr *msg = scr_str_concat(withKey, tail);`);
    d.push(`    scr_str_release(withKey);`);
    d.push(`    scr_str_release(tail);`);
    d.push(`    scr_throw_error(SCR_ERR_TYPE, msg); /* takes ownership */`);
    d.push(`    return NULL;`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_TYPED_REF) {`);
    d.push(`    ScrDyn *sc_materialized = scr_dyn_typed_ref_materialize(d);`);
    d.push(`    ScrDyn *sc_out = ${name}(sc_materialized, k, opt);`);
    d.push(`    scr_dyn_release(sc_materialized);`);
    d.push(`    return sc_out;`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_OBJ) {`);
    d.push(`    ScrDyn *m = scr_dyn_obj_get(d, k->data, k->len);`);
    d.push(`    return scr_dyn_retain(m ? m : scr_dyn_undefined());`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_JSVAL) {`);
    d.push(`    /* Island-held: o[k] reads the REAL engine property (getters`);
    d.push(`     * included, throws bridged catchably) and the result wraps`);
    d.push(`     * back scalar-normalized — the routed keyed read that retired`);
    d.push(`     * the fence (and before it, the fence box's .length -> 0). */`);
    d.push(`    return scr_dyn_isl_key_get(d, k);`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_HANDLE) {`);
    d.push(`    /* Native handles: the tag's modeled properties (req.url,`);
    d.push(`     * res.statusCode, ...) answer boxed values through the`);
    d.push(`     * installed ops; the rest is the undefined singleton or the`);
    d.push(`     * loud not-supported ladder (scr_json.c). */`);
    d.push(`    return scr_dyn_handle_key_get(d, k);`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_BYTES) {`);
    d.push(`    /* Buffer-shaped dyn (a stream's 'data' chunk in the JS lane):`);
    d.push(`     * .length and canonical-index byte reads answer like Node. */`);
    d.push(`    if (k->len == 6 && memcmp(k->data, "length", 6) == 0) {`);
    d.push(`      return scr_dyn_new_num((double)d->v.bytes->len);`);
    d.push(`    }`);
    d.push(`    if (k->len > 0 && !(k->len > 1 && k->data[0] == '0')) {`);
    d.push(`      size_t idx = 0; bool digits = true;`);
    d.push(`      for (size_t i = 0; i < k->len; i++) {`);
    d.push(`        if (k->data[i] < '0' || k->data[i] > '9' || idx > (SIZE_MAX - 9) / 10) { digits = false; break; }`);
    d.push(`        idx = idx * 10 + (size_t)(k->data[i] - '0');`);
    d.push(`      }`);
    d.push(`      if (digits && idx < d->v.bytes->len) return scr_dyn_new_num((double)d->v.bytes->data[idx]);`);
    d.push(`    }`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_FUNC) {`);
    d.push(`    /* own props (defineProperties writes), then name/length —`);
    d.push(`     * the function-instance members test/common copies. */`);
    d.push(`    ScrDyn *m = scr_dyn_fn_get(d, k->data, k->len);`);
    d.push(`    if (m) return m;`);
    d.push(`  }`);
    d.push(`  if (d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_STR) {`);
    d.push(`    if (k->len == 6 && memcmp(k->data, "length", 6) == 0) {`);
    d.push(`      return scr_dyn_new_num(d->kind == SCR_DYN_ARR ? (double)d->v.arr.len : scr_str_utf16_len(d->v.str));`);
    d.push(`    }`);
    d.push(`    if (k->len > 0 && !(k->len > 1 && k->data[0] == '0')) {`);
    d.push(`      /* canonical index: digits only, no leading zero — array`);
    d.push(`       * elements, and the string's 1-code-unit char ("abc"[1] is`);
    d.push(`       * "b" in JS; out of range reads as an absent key). */`);
    d.push(`      size_t idx = 0; bool digits = true;`);
    d.push(`      for (size_t i = 0; i < k->len; i++) {`);
    d.push(`        if (k->data[i] < '0' || k->data[i] > '9' || idx > (SIZE_MAX - 9) / 10) { digits = false; break; }`);
    d.push(`        idx = idx * 10 + (size_t)(k->data[i] - '0');`);
    d.push(`      }`);
    d.push(`      if (digits && d->kind == SCR_DYN_ARR && idx < d->v.arr.len) return scr_dyn_retain(d->v.arr.items[idx]);`);
    d.push(`      if (digits && d->kind == SCR_DYN_STR && (double)idx < scr_str_utf16_len(d->v.str)) {`);
    d.push(`        ScrStr *c = scr_str_char_at(d->v.str, (double)idx);`);
    d.push(`        ScrDyn *r = scr_dyn_new_str(c);`);
    d.push(`        scr_str_release(c);`);
    d.push(`        return r;`);
    d.push(`      }`);
    d.push(`    }`);
    d.push(`  }`);
    d.push(`  return scr_dyn_retain(scr_dyn_undefined());`);
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The emitted checked builder for one dynCheck target type:
   * `static T sc_dc_<n>(const ScrDyn *d, const ScrDynPath *path)` —
   * validate the checked-dynamic tree against T and BUILD the typed value (+1), or throw a
   * catchable, path-annotated TypeError-shaped string through the exception
   * cell and return a dummy (0/false/NULL) with the pending flag set.
   * Recursive calls propagate a pending exception by releasing the
   * partially-built value and returning — the same pending-check discipline
   * emitted function bodies follow. */
  export function dynCheckHelper(E: CEmitter, t: IrType): string {
    const key = typeKey(t);
    const existing = E.dynBuilders.get(key);
    if (existing) return existing;
    const name = `sc_dc_${E.dynBuilders.size}`;
    E.dynBuilders.set(key, name);
    const sig = `static ${cType(t)}${cType(t).endsWith("*") ? "" : " "}${name}(const ScrDyn *d, const ScrDynPath *path)`;
    E.walkerProtos.push(`${sig}; /* check ${key} */`);
    const want = cStringLiteral(Buffer.from(dynDesc(t, E.recordsById, E.unionsById), "utf8"));
    const d: string[] = [`${sig} { /* check ${key} */`];
    if (isRefCounted(t) && t.kind !== "dyn") {
      const keyLit = cStringLiteral(Buffer.from(key, "utf8"));
      const keyLen = Buffer.byteLength(key, "utf8");
      d.push(
        `  if (scr_dyn_typed_ref_is(d, ${keyLit}, ${keyLen})) {`,
        `    return (${cType(t).trim()})scr_dyn_typed_ref_unbox(d);`,
        `  }`,
      );
      if (t.kind !== "union") {
        const rc = vAdapters(t);
        d.push(
          `  if (d && d->kind == SCR_DYN_TYPED_REF) {`,
          `    ${cDecl(t, "sc_cached")} = (${cType(t).trim()})scr_dyn_typed_ref_cached_cast(d, ${keyLit}, ${keyLen});`,
        );
        if (t.kind !== "record" && t.kind !== "array") {
          d.push(`    if (sc_cached) return sc_cached;`);
        }
        d.push(
          `    ScrDyn *sc_materialized = scr_dyn_typed_ref_materialize(d);`,
          `    ${cDecl(t, "sc_out")} = ${name}(sc_materialized, path);`,
          `    scr_dyn_release(sc_materialized);`,
        );
        if (t.kind === "record") {
          const shape = E.recordsById.get(t.shapeId);
          if (!shape) {
            throw new InternalCompilerError(
              `emitter bug: cached typed-ref cast of unknown shape ${t.shapeId}`,
            );
          }
          d.push(`    if (sc_out && sc_cached) {`);
          for (const field of shape.fields) {
            const member = mangleField(field.name);
            d.push(
              `      {`,
              `        ${cDecl(field.type, "sc_old")} = sc_cached->${member};`,
              `        sc_cached->${member} = sc_out->${member};`,
              `        sc_out->${member} = sc_old;`,
              `      }`,
            );
          }
          if (shape.indexValue) {
            d.push(
              `      ScrMap *sc_old = sc_cached->${OVERFLOW_MEMBER};`,
              `      sc_cached->${OVERFLOW_MEMBER} = sc_out->${OVERFLOW_MEMBER};`,
              `      sc_out->${OVERFLOW_MEMBER} = sc_old;`,
            );
          }
          d.push(
            `      ${releaseCallC(t, "sc_out")};`,
            `      return sc_cached;`,
            `    }`,
            `    if (sc_cached) ${releaseCallC(t, "sc_cached")};`,
          );
        } else if (t.kind === "array") {
          d.push(
            `    if (sc_out && sc_cached) {`,
            `      size_t sc_old_len = sc_cached->len;`,
            `      size_t sc_old_cap = sc_cached->cap;`,
            `      uint64_t *sc_old_data = sc_cached->data;`,
            `      sc_cached->len = sc_out->len;`,
            `      sc_cached->cap = sc_out->cap;`,
            `      sc_cached->data = sc_out->data;`,
            `      sc_out->len = sc_old_len;`,
            `      sc_out->cap = sc_old_cap;`,
            `      sc_out->data = sc_old_data;`,
            `      scr_arr_release(sc_out);`,
            `      return sc_cached;`,
            `    }`,
            `    if (sc_cached) scr_arr_release(sc_cached);`,
          );
        }
        d.push(
          `    if (sc_out) {`,
          `      scr_dyn_typed_ref_cache_cast((ScrDyn *)d, ${keyLit}, ${keyLen}, sc_out, &${rc.retain}, &${rc.release});`,
          `    }`,
          `    return sc_out;`,
          `  }`,
        );
      }
    }
    switch (t.kind) {
      case "f64":
        d.push(`  if (d->kind != SCR_DYN_NUM) { scr_dyn_check_fail(path, ${want}, d); return 0; }`);
        d.push(`  return d->v.num;`);
        break;
      case "bool":
        d.push(`  if (d->kind != SCR_DYN_BOOL) { scr_dyn_check_fail(path, ${want}, d); return false; }`);
        d.push(`  return d->v.b;`);
        break;
      case "string":
        d.push(`  if (d->kind != SCR_DYN_STR) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
        d.push(`  return scr_str_retain(d->v.str);`);
        break;
      case "dyn":
        // An `unknown` slot passes through as-is. Typed Web-stream transit
        // capsules stay wrapped so repeated references keep identity;
        // generic operations materialize their one cached detached view.
        d.push(`  (void)path;`);
        d.push(`  return scr_dyn_retain((ScrDyn *)d);`);
        break;
      case "bytes":
        // `u as Uint8Array`: kind check, then a fresh COPY out (the
        // boundary's aliasing stance in both directions).
        if (t.elem !== "u8") throw new InternalCompilerError(`emitter bug: dynCheck of bytes<${t.elem}>`);
        d.push(`  if (d->kind != SCR_DYN_BYTES) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
        d.push(`  return scr_dyn_bytes_copy_out(d);`);
        break;
      case "object":
        // The %Error extraction (an instanceof-Error narrow on unknown):
        // validate the checked-dynamic tree's error encoding — the reserved "%error" marker
        // caughtToDyn builds — and extract through the runtime's IDENTITY
        // CACHE (scr_error_from_dyn): a dyn error that came from a runtime
        // ScrError answers that very instance, so out-and-back crossings
        // compare reference-equal (the tracing suite's shape); alien
        // %error objects rebuild once and cache the pair.
        if (t.className !== "%Error") {
          throw new InternalCompilerError(`emitter bug: dynCheck of class ${t.className} (only %Error extracts from the checked-dynamic tree)`);
        }
        d.push(`  if (d->kind != SCR_DYN_OBJ || !scr_dyn_obj_get(d, "%error", 6)) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
        d.push(`  return scr_error_from_dyn(d);`);
        break;
      case "record": {
        const shape = E.recordsById.get(t.shapeId);
        if (!shape) throw new InternalCompilerError(`emitter bug: dynCheck of unknown shape ${t.shapeId}`);
        const rel = (v: string) => releaseCallC(t, v);
        // Tuple targets: a JSON ARRAY of exactly the arity, validated and
        // extracted positionally with index paths ("$.pairs[3][1]").
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          const arityWant = cStringLiteral(
            Buffer.from(`array of length ${byIndex.length}`, "utf8"),
          );
          d.push(`  if (d->kind != SCR_DYN_ARR) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
          d.push(`  if (d->v.arr.len != ${byIndex.length}) { scr_dyn_check_fail(path, ${arityWant}, d); return NULL; }`);
          d.push(`  ${cDecl(t, "r")} = ${mangleRecordNew(t.shapeId)}();`);
          byIndex.forEach((f, i) => {
            d.push(`  {`);
            d.push(`    ScrDynPath p = { path, NULL, ${i} };`);
            d.push(`    r->${mangleField(f.name)} = ${E.dynCheckHelper(f.type)}(d->v.arr.items[${i}], &p);`);
            d.push(`    if (scr_exc_pending()) { ${rel("r")}; return NULL; }`);
            d.push(`  }`);
          });
          d.push(`  return r;`);
          break;
        }
        d.push(`  if (d->kind != SCR_DYN_OBJ) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
        d.push(`  ${cDecl(t, "r")} = ${mangleRecordNew(t.shapeId)}();`);
        for (const f of shape.fields) {
          const keyLit = cStringLiteral(Buffer.from(f.name, "utf8"));
          const keyLen = Buffer.byteLength(f.name, "utf8");
          const fieldWant = cStringLiteral(Buffer.from(dynDesc(f.type, E.recordsById, E.unionsById), "utf8"));
          // Width tolerance: only declared fields are looked up — extra JSON
          // keys are simply never examined (check-and-extract, not shape
          // equality). A missing field fails as "got undefined" — except
          // optional-flavored fields (undefined-armed unions), where the
          // missing key IS the undefined arm: the interned immortal
          // instance, no retain owed (rc == SIZE_MAX).
          const utag = f.type.kind === "union" ? undefinedArmTag(f.type, E.unionsById) : -1;
          d.push(`  {`);
          d.push(`    ScrDynPath p = { path, ${keyLit}, 0 };`);
          d.push(`    const ScrDyn *m = scr_dyn_obj_get(d, ${keyLit}, ${keyLen});`);
          if (f.type.kind === "dyn") {
            // An `unknown` field: a present key passes through, a missing
            // one IS the undefined dyn value (JS's missing-property read).
            // Go through the dyn builder so a Web-stream typed-ref capsule
            // cannot escape inside a checked record field.
            d.push(`    r->${mangleField(f.name)} = ${E.dynCheckHelper(f.type)}(m ? m : scr_dyn_undefined(), &p);`);
          } else if (utag >= 0 && f.type.kind === "union") {
            const unit = E.unitInstanceRef(f.type.unionId, utag);
            d.push(`    if (!m) {`);
            d.push(`      r->${mangleField(f.name)} = ${unit}; /* absent key -> the undefined arm */`);
            d.push(`    } else {`);
            d.push(`      r->${mangleField(f.name)} = ${E.dynCheckHelper(f.type)}(m, &p);`);
            d.push(`      if (scr_exc_pending()) { ${rel("r")}; return NULL; }`);
            d.push(`    }`);
          } else {
            d.push(`    if (!m) { scr_dyn_check_fail(&p, ${fieldWant}, NULL); ${rel("r")}; return NULL; }`);
            d.push(`    r->${mangleField(f.name)} = ${E.dynCheckHelper(f.type)}(m, &p);`);
            d.push(`    if (scr_exc_pending()) { ${rel("r")}; return NULL; }`);
          }
          d.push(`  }`);
        }
        // Index-signature shapes CAPTURE undeclared keys into the overflow
        // map (width tolerance became width capture — plain shapes above
        // keep ignoring extras). dyn value types retain the checked-dynamic tree subtree
        // as-is; concrete types validate each entry with its key path.
        if (shape.indexValue) {
          const iv = shape.indexValue;
          const skip = shape.fields
            .map((f) => {
              const keyLit = cStringLiteral(Buffer.from(f.name, "utf8"));
              const keyLen = Buffer.byteLength(f.name, "utf8");
              return `(e->key_len == ${keyLen} && memcmp(e->key, ${keyLit}, ${keyLen}) == 0)`;
            })
            .join(" || ");
          d.push(`  for (size_t i = 0; i < d->v.obj.len; i++) {`);
          d.push(`    const ScrDynEntry *e = &d->v.obj.entries[i];`);
          if (shape.fields.length > 0) d.push(`    if (${skip}) continue;`);
          if (iv.kind === "dyn") {
            d.push(`    ${cDecl(iv, "ev")} = scr_dyn_retain(e->value);`);
          } else {
            d.push(`    ScrDynPath p = { path, e->key, 0 };`);
            d.push(`    ${cDecl(iv, "ev")} = ${E.dynCheckHelper(iv)}(e->value, &p);`);
            d.push(`    if (scr_exc_pending()) { ${rel("r")}; return NULL; }`);
          }
          d.push(`    ScrStr *ek = scr_str_new(e->key, e->key_len);`);
          if (iv.kind === "f64" || iv.kind === "bool") {
            d.push(`    scr_map_set_str_${iv.kind === "f64" ? "f64" : "bool"}(r->${OVERFLOW_MEMBER}, ek, ev);`);
          } else {
            d.push(`    scr_map_set_str_ref(r->${OVERFLOW_MEMBER}, ek, ev);`);
          }
          d.push(`    scr_str_release(ek);`);
          d.push(`  }`);
        }
        d.push(`  return r;`);
        break;
      }
      case "array": {
        const elem = t.elem;
        const c = E.dynCheckHelper(elem);
        d.push(`  if (d->kind != SCR_DYN_ARR) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
        d.push(`  ScrArr *a = ${E.arrNewC(elem, "d->v.arr.len")};`);
        d.push(`  for (size_t i = 0; i < d->v.arr.len; i++) {`);
        d.push(`    ScrDynPath p = { path, NULL, i };`);
        d.push(`    ${cDecl(elem, "e")} = ${c}(d->v.arr.items[i], &p);`);
        d.push(`    if (scr_exc_pending()) { scr_arr_release(a); return NULL; }`);
        d.push(`    scr_arr_push_${elemAccess(elem)}(a, e);`);
        d.push(`  }`);
        d.push(`  return a;`);
        break;
      }
      case "union": {
        const def = E.unionsById.get(t.unionId);
        if (!def) throw new InternalCompilerError(`emitter bug: dynCheck of unknown union ${t.unionId}`);
        // Arms in CANONICAL order, first FULL match wins (discriminated
        // unions disambiguate naturally: the arm whose declared fields all
        // fit). The matched arm's builder can no longer fail.
        def.arms.forEach((arm, i) => {
          const m = E.dynMatchHelper(arm);
          if (arm.kind === "undefinedT") {
            // Parsed JSON never matches here (no undefined in JSON text —
            // a MISSING record key builds this arm in the record builder
            // above), but the undefined dyn value can arrive from
            // `unknown` index-signature overflows and builds the interned
            // unit instance exactly like null.
            d.push(`  if (${m}(d)) {`);
            d.push(`    return ${E.unitInstanceRef(t.unionId, i)};`);
            d.push(`  }`);
            return;
          }
          if (arm.kind === "nullT") {
            // A matched unit arm builds nothing: the result is THE interned
            // immortal instance (rc == SIZE_MAX — RC entry points and the
            // collector both skip it, so no retain is owed).
            d.push(`  if (${m}(d)) {`);
            d.push(`    return ${E.unitInstanceRef(t.unionId, i)};`);
            d.push(`  }`);
            return;
          }
          const c = E.dynCheckHelper(arm);
          d.push(`  if (${m}(d)) {`);
          if (arm.kind === "f64") {
            d.push(`    return scr_union_new_f64(${i}, ${c}(d, path));`);
          } else if (arm.kind === "bool") {
            d.push(`    return scr_union_new_bool(${i}, ${c}(d, path));`);
          } else {
            const rc = vAdapters(arm);
            d.push(`    return scr_union_new_ref(${i}, ${c}(d, path), &${rc.retain}, &${rc.release}, ${E.traceArgC(arm)});`);
          }
          d.push(`  }`);
        });
        // A typed stream capsule may fit one arm EXACTLY; those probes run
        // first so the matching arm can preserve object identity. Only when
        // no arm matches the producer tag do we snapshot and retry the
        // ordinary copy-based structural union check (the compiler's width
        // coercion stance, rather than a live narrowed alias).
        d.push(`  if (d && d->kind == SCR_DYN_TYPED_REF) {`);
        {
          const keyLit = cStringLiteral(Buffer.from(key, "utf8"));
          const keyLen = Buffer.byteLength(key, "utf8");
          const rc = vAdapters(t);
          d.push(`    ${cDecl(t, "sc_cached")} = (${cType(t).trim()})scr_dyn_typed_ref_cached_cast(d, ${keyLit}, ${keyLen});`);
          d.push(`    ScrDyn *sc_materialized = scr_dyn_typed_ref_materialize(d);`);
          d.push(`    ${cDecl(t, "sc_out")} = ${name}(sc_materialized, path);`);
          d.push(`    scr_dyn_release(sc_materialized);`);
          d.push(`    if (sc_out && sc_cached) {`);
          d.push(`      size_t sc_cached_rc = sc_cached->rc;`);
          d.push(`      size_t sc_out_rc = sc_out->rc;`);
          d.push(`      ScrUnion sc_old = *sc_cached;`);
          d.push(`      *sc_cached = *sc_out;`);
          d.push(`      sc_cached->rc = sc_cached_rc;`);
          d.push(`      *sc_out = sc_old;`);
          d.push(`      sc_out->rc = sc_out_rc;`);
          d.push(`      scr_union_release(sc_out);`);
          d.push(`      return sc_cached;`);
          d.push(`    }`);
          d.push(`    if (sc_cached) scr_union_release(sc_cached);`);
          d.push(`    if (sc_out) {`);
          d.push(`      scr_dyn_typed_ref_cache_cast((ScrDyn *)d, ${keyLit}, ${keyLen}, sc_out, &${rc.retain}, &${rc.release});`);
          d.push(`    }`);
          d.push(`    return sc_out;`);
        }
        d.push(`  }`);
        d.push(`  scr_dyn_check_fail(path, ${want}, d);`);
        d.push(`  return NULL;`);
        break;
      }
      case "func": {
        // The checked-dynamic function boundary, OUT direction: a
        // non-function kind fails like any dynCheck; an IDENTICAL boxed
        // signature (the interned typeKey — same key ⇔ same IR type ⇔
        // same ABI) unwraps the closure directly (identity preserved:
        // `mustCall(fn)` handed back to a slot of fn's own type IS fn's
        // wrapper, retained); anything else wraps in the per-target
        // adapter closure, whose caps[0] obj-box owns the dyn value
        // (untraced — cycles through dyn never collect, SEMANTICS.md).
        const adapter = dynFuncAdapterHelper(E, t);
        const sigLit = cStringLiteral(Buffer.from(key, "utf8"));
        d.push(`  if (d->kind != SCR_DYN_FUNC) { scr_dyn_check_fail(path, ${want}, d); return NULL; }`);
        d.push(`  if (strcmp(d->v.fn.sig, ${sigLit}) == 0) return scr_closure_retain(d->v.fn.clo);`);
        d.push(`  {`);
        d.push(`    ScrClosure *a = scr_closure_new((void *)&${adapter}, 1);`);
        d.push(`    a->caps[0] = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);`);
        d.push(`    scr_box_set_ref(a->caps[0], scr_dyn_retain((ScrDyn *)d));`);
        d.push(`    return a;`);
        d.push(`  }`);
        break;
      }
      default: {
        // Runtime HANDLE targets: a tag-checked reference unwrap (+1 —
        // identity, no copy; the runtime throws the path-annotated
        // TypeError on any other kind or tag).
        const h = DYN_HANDLE_KINDS.get(t.kind);
        if (h) {
          d.push(`  return (${cType(t).trim()})scr_dyn_handle_unbox(d, ${h.tag}, path, ${want});`);
          break;
        }
        throw new InternalCompilerError(`emitter bug: dynCheck of non-JSON type ${t.kind}`);
      }
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The emitted static→dyn converter for one type:
   * `static ScrDyn *sc_td_<n>(<T> v)` — build a fresh dyn value from a
   * static one (+1), DEEP-COPYING composites (a dyn value never aliases
   * static storage — the jsMarshal stance). Domain: the JSON-safe kinds
   * plus undefined-armed unions (the undefined arm becomes the undefined
   * dyn singleton) and index-signature records (whose overflow entries
   * copy over). The operand is borrowed. Never throws. */
  export function toDynHelper(E: CEmitter, t: IrType): string {
    const key = typeKey(t);
    const existing = E.toDynFns.get(key);
    if (existing) return existing;
    const name = `sc_td_${E.toDynFns.size}`;
    E.toDynFns.set(key, name);
    const sig = `static ScrDyn *${name}(${cDecl(t, "v")})`;
    E.walkerProtos.push(`${sig}; /* to-dyn ${key} */`);
    const d: string[] = [`${sig} { /* to-dyn ${key} */`];
    let sourceAccessor: { name: string; release: string } | null = null;
    switch (t.kind) {
      case "f64":
        d.push(`  return scr_dyn_new_num(v);`);
        break;
      case "bool":
        d.push(`  return scr_dyn_new_bool(v);`);
        break;
      case "string":
        d.push(`  return scr_dyn_new_str(v); /* retains v */`);
        break;
      case "undefinedT":
        // A bare unit field (`x: undefined` in a record — the tls
        // options-record's explicit-absent member): the dyn unit value.
        d.push(`  (void)v; return scr_dyn_retain(scr_dyn_undefined());`);
        break;
      case "nullT":
        d.push(`  (void)v; return scr_dyn_new_null();`);
        break;
      case "object":
        // %Error only (canConvertToDyn's gate): the checked-dynamic tree's error encoding.
        if (t.className !== "%Error") {
          throw new InternalCompilerError(`emitter bug: to-dyn of class ${t.className}`);
        }
        d.push(`  return scr_dyn_from_error(v);`);
        break;
      case "dyn":
        // A dyn member of a converting composite (a dyn record field): the
        // dyn value passes through by reference — already a dyn, already
        // immutable-through-copies.
        d.push(`  return scr_dyn_retain(v);`);
        break;
      case "func":
        // Function-valued record/array fields (EventListenerObject's
        // handleEvent method) box through the same identity-preserving
        // closure bridge as a bare dynFrom function.
        d.push(`  return ${dynFuncBoxHelper(E, t)}(v, NULL);`);
        break;
      case "bytes":
        // bytes<u8> → the checked-dynamic tree's bytes kind, payload COPIED (the boundary
        // stance; stdin chunks into unknown-typed helpers).
        if (t.elem !== "u8") throw new InternalCompilerError(`emitter bug: to-dyn of bytes<${t.elem}>`);
        d.push(`  return scr_dyn_new_bytes_copy(v);`);
        break;
      case "record": {
        const shape = E.recordsById.get(t.shapeId);
        if (!shape) throw new InternalCompilerError(`emitter bug: to-dyn of unknown shape ${t.shapeId}`);
        // CYCLE-CAPABLE shapes guard the deep copy: a cyclic value has no
        // finite dyn copy, so enter TRAPS on re-entry (SEMANTICS.md — Node
        // shares the reference instead of copying).
        const cyclicRec = E.traceAdapterC(t) !== null;
        if (cyclicRec) d.push(`  scr_dyn_from_enter(v);`);
        if (shape.tuple) {
          // A tuple converts as the JSON ARRAY it is everywhere else.
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          d.push(`  ScrDyn *d = scr_dyn_new_arr();`);
          for (const f of byIndex) {
            d.push(`  scr_dyn_arr_push(d, ${E.toDynHelper(f.type)}(v->${mangleField(f.name)}));`);
          }
          if (cyclicRec) d.push(`  scr_dyn_from_leave();`);
          d.push(`  return d;`);
          break;
        }
        const carriesListenerIdentity = shape.fields.some(
          (f) => f.name === "handleEvent" && f.type.kind === "func",
        );
        if (carriesListenerIdentity) {
          const rc = vAdapters(t);
          sourceAccessor = {
            name: `${name}_source_access`,
            release: rc.release,
          };
          E.walkerProtos.push(
            `static ScrDyn *${sourceAccessor.name}(void *v, bool materialize); /* live listener source ${key} */`,
          );
          d.push(
            `  ScrDyn *d = scr_dyn_new_obj_with_identity(v, &${rc.retain}, &${sourceAccessor.name});`,
          );
        } else {
          d.push(`  ScrDyn *d = scr_dyn_new_obj();`);
        }
        // Keys insert in DECLARED order — the dyn object's insertion order
        // is observable (Object.keys/for-in over checked-dynamic values,
        // dyn JSON), so it must be JS's (SEMANTICS.md 36's stance, same as
        // the JSON writer above). Internal '%'-fields declaredOrder omits
        // still enter the checked-dynamic tree (after the visible keys) so a
        // record→dyn→record round trip keeps their data.
        {
          const byName = new Map(shape.fields.map((f) => [f.name, f]));
          const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
          const inOrder = new Set(order);
          const dynFields = [
            ...order.map((n) => byName.get(n)).filter((f) => f !== undefined),
            ...shape.fields.filter((f) => !inOrder.has(f.name)),
          ];
          for (const f of dynFields) {
            const keyLit = cStringLiteral(Buffer.from(f.name, "utf8"));
            const keyLen = Buffer.byteLength(f.name, "utf8");
            d.push(`  scr_dyn_obj_set(d, ${keyLit}, ${keyLen}, ${E.toDynHelper(f.type)}(v->${mangleField(f.name)}));`);
          }
        }
        if (shape.indexValue) {
          const iv = shape.indexValue;
          const m = `v->${OVERFLOW_MEMBER}`;
          // JS OWN-KEY order (integer-like keys ascending first) — the same
          // enumeration Object.keys and the JSON writer answer.
          d.push(`  {`);
          d.push(`    ScrArr *ks = scr_map_keys_js_order(${m});`);
          d.push(`    for (size_t i = 0; i < ks->len; i++) {`);
          d.push(`      ScrStr *k = (ScrStr *)scr_arr_get_ref(ks, (double)i);`);
          if (iv.kind === "f64" || iv.kind === "bool") {
            d.push(`      ${cDecl(iv, "sv")} = 0;`);
            d.push(`      scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(${m}, k, &sv);`);
            d.push(`      scr_dyn_obj_set(d, k->data, k->len, scr_dyn_new_${iv.kind === "f64" ? "num" : "bool"}(sv));`);
          } else if (iv.kind === "dyn") {
            // get_str_ref returns +1 — exactly the ownership obj_set takes.
            d.push(`      scr_dyn_obj_set(d, k->data, k->len, (ScrDyn *)scr_map_get_str_ref(${m}, k));`);
          } else {
            d.push(`      ${cDecl(iv, "e")} = (${cType(iv).trim()})scr_map_get_str_ref(${m}, k);`);
            d.push(`      scr_dyn_obj_set(d, k->data, k->len, ${E.toDynHelper(iv)}(e));`);
            d.push(`      ${releaseCallC(iv, "e")};`);
          }
          d.push(`      scr_str_release(k);`);
          d.push(`    }`);
          d.push(`    scr_arr_release(ks);`);
          d.push(`  }`);
        }
        if (cyclicRec) d.push(`  scr_dyn_from_leave();`);
        d.push(`  return d;`);
        break;
      }
      case "array": {
        const elem = t.elem;
        // Cycle-capable arrays guard the deep copy like records above.
        const cyclicArr = E.traceAdapterC(t) !== null;
        if (cyclicArr) d.push(`  scr_dyn_from_enter(v);`);
        d.push(`  ScrDyn *d = scr_dyn_new_arr();`);
        d.push(`  for (size_t i = 0; i < v->len; i++) {`);
        if (elem.kind === "f64") {
          d.push(`    scr_dyn_arr_push(d, scr_dyn_new_num(scr_arr_get_f64(v, (double)i)));`);
        } else if (elem.kind === "bool") {
          d.push(`    scr_dyn_arr_push(d, scr_dyn_new_bool(scr_arr_get_bool(v, (double)i)));`);
        } else {
          d.push(`    ${cDecl(elem, "e")} = (${cType(elem).trim()})scr_arr_get_ref(v, (double)i);`);
          d.push(`    scr_dyn_arr_push(d, ${E.toDynHelper(elem)}(e));`);
          d.push(`    ${releaseCallC(elem, "e")};`);
        }
        d.push(`  }`);
        if (cyclicArr) d.push(`  scr_dyn_from_leave();`);
        d.push(`  return d;`);
        break;
      }
      case "union": {
        const def = E.unionsById.get(t.unionId);
        if (!def) throw new InternalCompilerError(`emitter bug: to-dyn of unknown union ${t.unionId}`);
        d.push(`  switch (v->tag) {`);
        def.arms.forEach((arm, i) => {
          if (arm.kind === "undefinedT") {
            d.push(`  case ${i}: return scr_dyn_retain(scr_dyn_undefined());`);
          } else if (arm.kind === "nullT") {
            d.push(`  case ${i}: return scr_dyn_new_null();`);
          } else if (arm.kind === "f64") {
            d.push(`  case ${i}: return scr_dyn_new_num(scr_union_get_f64(v));`);
          } else if (arm.kind === "bool") {
            d.push(`  case ${i}: return scr_dyn_new_bool(scr_union_get_bool(v));`);
          } else if (arm.kind === "func") {
            // A boxable function arm crosses through the checked-dynamic
            // function boundary (the dynFrom func special case, sans name).
            d.push(`  case ${i}: return ${dynFuncBoxHelper(E, arm)}((ScrClosure *)scr_union_peek(v), NULL);`);
          } else {
            d.push(`  case ${i}: return ${E.toDynHelper(arm)}((${cType(arm).trim()})scr_union_peek(v));`);
          }
        });
        d.push(`  default: scr_trap("scriptc: internal error: invalid union tag\\n");`);
        d.push(`  }`);
        break;
      }
      case "promise": {
        // Promises box by REFERENCE (SCR_DYN_PROMISE — identity is the
        // promise): promise<dyn> carries its ScrPromise directly (the
        // payload is already a dyn value); any other inner boxes an
        // ADAPTER promise whose settle callback converts the payload
        // (rejections copy raw inside the runtime's cb-waiter machinery).
        if (t.inner.kind === "dyn") {
          d.push(`  return scr_dyn_new_promise(v);`);
          break;
        }
        d.push(`  return scr_dyn_new_promise_adapting(v, &${promiseDynAdapterHelper(E, t.inner)});`);
        break;
      }
      default: {
        // Runtime HANDLE kinds box by REFERENCE (identity — no copy):
        // scr_dyn_new_handle retains the borrowed operand through the
        // tag's installed ops.
        const h = DYN_HANDLE_KINDS.get(t.kind);
        if (h) {
          d.push(`  return scr_dyn_new_handle(v, ${h.tag});`);
          break;
        }
        throw new InternalCompilerError(`emitter bug: to-dyn of unsupported type ${t.kind}`);
      }
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    if (sourceAccessor) {
      E.walkerDefs.push(
        `static ScrDyn *${sourceAccessor.name}(void *v, bool materialize) {`,
        `  if (materialize) return ${name}((${cType(t).trim()})v);`,
        `  ${sourceAccessor.release}(v);`,
        `  return NULL;`,
        `}`,
        ``,
      );
    }
    return name;
  }

/** The checked-dynamic tree-promise settle adapter for one fulfillment payload type:
   * `static void sc_pda_<n>(ScrPromise *dst, ScrPromise *src)` — read
   * src's fulfilled payload by its compile-time kind, convert it to a dyn
   * value, and fulfill dst with it (scr_dyn_new_promise_adapting's
   * callback; rejections never reach an adapter — the runtime copies them
   * raw). Interned per inner typeKey. */
  function promiseDynAdapterHelper(E: CEmitter, inner: IrType): string {
    const key = typeKey(inner);
    const existing = E.promiseDynAdapters.get(key);
    if (existing) return existing;
    const name = `sc_pda_${E.promiseDynAdapters.size}`;
    E.promiseDynAdapters.set(key, name);
    const sig = `static void ${name}(ScrPromise *dst, ScrPromise *src)`;
    E.walkerProtos.push(`${sig}; /* dyn-box settle adapter for promise<${key}> */`);
    const d: string[] = [`${sig} { /* dyn-box settle adapter for promise<${key}> */`];
    const fulfill = (expr: string) =>
      `  scr_promise_fulfill_ref(dst, ${expr}, scr_dyn_retain_v, scr_dyn_release_v, NULL);`;
    switch (inner.kind) {
      case "void":
      case "undefinedT":
        d.push(`  (void)src;`);
        d.push(fulfill(`scr_dyn_retain(scr_dyn_undefined())`));
        break;
      case "nullT":
        d.push(`  (void)src;`);
        d.push(fulfill(`scr_dyn_new_null()`));
        break;
      case "f64":
        d.push(fulfill(`scr_dyn_new_num(scr_promise_payload_f64(src))`));
        break;
      case "bool":
        d.push(fulfill(`scr_dyn_new_bool(scr_promise_payload_bool(src))`));
        break;
      case "string":
        d.push(`  ScrStr *s = scr_promise_payload_str(src);`);
        d.push(`  ScrDyn *dv = scr_dyn_new_str(s); /* retains s */`);
        d.push(`  scr_str_release(s);`);
        d.push(fulfill(`dv`));
        break;
      default: {
        // Ref-payload inners (records, arrays, bytes, %Error, unions,
        // nested promises, handles): extract (+1 via the stored retain),
        // convert through the shared to-dyn spelling, release the extract.
        d.push(`  ${cDecl(inner, "pv")} = (${cType(inner).trim()})scr_promise_payload_ref(src);`);
        d.push(`  ScrDyn *dv = ${toDynExprC(E, inner, "pv")};`);
        if (isRefCounted(inner)) d.push(`  ${releaseCallC(inner, "pv")};`);
        d.push(fulfill(`dv`));
        break;
      }
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/* ── the checked-dynamic function boundary (nodes.ts) ─────────────────
   * Three interned per-signature helpers:
   *
   *   sc_dfk_<n> — the CALL THUNK a dyn-boxed closure carries: validate
   *   each dyn argument into the declared param type (JS arity: extras
   *   ignored, missing args are the undefined dyn value — a param type
   *   the undefined value fails checks throws the path-annotated
   *   TypeError), call through the closure, convert the result back to a
   *   dyn value (+1).
   *
   *   sc_dfb_<n> — the BOX builder dynFrom emits: a fresh SCR_DYN_FUNC
   *   node carrying the retained closure, the thunk, the arity, the
   *   interned signature key (typeKey — dynCheck's exact-unwrap fast
   *   path), and the best-effort name.
   *
   *   sc_dfa_<n> — the ADAPTER a func-targeted dynCheck wraps a
   *   NON-identical boxed signature in: a closure of the TARGET type
   *   whose body converts each typed argument INTO dyn, calls the boxed
   *   thunk, and validates the dyn result into the target's return type.
   */

/** The dyn argument spelling of one static value (thunk results, adapter
   * arguments): dyn passes through (+1 via retain — callers own the
   * result uniformly), funcs box (anonymous — the static name is gone by
   * the time a value flows through an adapter; SEMANTICS.md), everything
   * else rides the toDyn converter. `expr` is BORROWED in every arm. */
  function toDynExprC(E: CEmitter, t: IrType, expr: string): string {
    if (t.kind === "dyn") return `scr_dyn_retain(${expr})`;
    if (t.kind === "func") return `${E.dynFuncBoxHelper(t)}(${expr}, NULL)`;
    // An island value wraps by reference (scalar-normalizing) — the
    // jsval-returning callback shape of the routed-dispatch lane.
    if (t.kind === "jsval") return `scr_dyn_from_jsval(${expr})`;
    return `${E.toDynHelper(t)}(${expr})`;
  }

/** The call thunk for one closure signature (see the block comment). */
  function dynFuncThunkHelper(E: CEmitter, t: IrType & { kind: "func" }): string {
    const key = typeKey(t);
    const existing = E.dynFuncThunks.get(key);
    if (existing) return existing;
    const name = `sc_dfk_${E.dynFuncThunks.size}`;
    E.dynFuncThunks.set(key, name);
    const sig = `static ScrDyn *${name}(ScrClosure *c, ScrDyn *const *args, size_t argc)`;
    E.walkerProtos.push(`${sig}; /* dyn call thunk for ${key} */`);
    const d: string[] = [`${sig} { /* dyn call thunk for ${key} */`];
    if (t.params.length === 0) d.push(`  (void)args;`);
    d.push(`  (void)argc;`);
    t.params.forEach((p, i) => {
      // JS arity: a missing argument IS the undefined dyn value; the
      // param's own check decides whether that flies (dyn params take
      // anything; a number param throws the catchable TypeError).
      d.push(`  ${cDecl(p, `a${i}`)};`);
      d.push(`  {`);
      d.push(`    const ScrDyn *ad = ${i} < argc ? args[${i}] : scr_dyn_undefined();`);
      if (p.kind === "dyn") {
        d.push(`    a${i} = scr_dyn_retain((ScrDyn *)ad);`);
      } else if (p.kind === "jsval") {
        // A checker-'any' param: the dyn argument enters the island —
        // wrapped cells unwrap by reference, data deep-copies, boxed
        // functions cross through the host shim; a kind with no crossing
        // throws the catchable TypeError (NULL + pending).
        d.push(`    a${i} = scr_jsval_from_dyn(ad);`);
        const undo = t.params
          .slice(0, i)
          .flatMap((q, j) => (isRefCounted(q) ? [`${releaseCallC(q, `a${j}`)};`] : []));
        d.push(`    if (!a${i}) { ${undo.join(" ")}${undo.length > 0 ? " " : ""}return NULL; }`);
      } else {
        d.push(`    ScrDynPath pp = { NULL, NULL, ${i} };`);
        d.push(`    a${i} = ${E.dynCheckHelper(p)}(ad, &pp);`);
        const undo = t.params
          .slice(0, i)
          .flatMap((q, j) => (isRefCounted(q) ? [`${releaseCallC(q, `a${j}`)};`] : []));
        d.push(`    if (scr_exc_pending()) { ${undo.join(" ")}${undo.length > 0 ? " " : ""}return NULL; }`);
      }
      d.push(`  }`);
    });
    // VARIADIC (rest-marked) signatures: one extra trailing dyn-array
    // param carries the call's arguments from index params.length on —
    // the mustCall wrapper's `arguments`, a JS `...args`. Built fresh per
    // call (+1, moved into the callee like every param).
    if (t.rest) {
      d.push(`  ScrDyn *rest = scr_dyn_new_arr();`);
      d.push(`  for (size_t ri = ${t.params.length}; ri < argc; ri++) {`);
      d.push(`    scr_dyn_arr_push(rest, scr_dyn_retain((ScrDyn *)args[ri]));`);
      d.push(`  }`);
    }
    // The closure CONSUMES its params (+1 each moved in — exactly what the
    // builders above returned).
    const castParams = ["ScrClosure *", ...t.params.map((p) => cType(p).trim()), ...(t.rest ? ["ScrDyn *"] : [])].join(", ");
    const call = `((${cType(t.ret).trim()} (*)(${castParams}))c->fn)(${["c", ...t.params.map((_, i) => `a${i}`), ...(t.rest ? ["rest"] : [])].join(", ")})`;
    if (t.ret.kind === "void") {
      d.push(`  ${call};`);
      d.push(`  if (scr_exc_pending()) return NULL;`);
      d.push(`  return scr_dyn_retain(scr_dyn_undefined());`);
    } else if (t.ret.kind === "dyn") {
      d.push(`  ScrDyn *r = ${call};`);
      d.push(`  if (scr_exc_pending()) return NULL;`);
      d.push(`  return r;`);
    } else {
      d.push(`  ${cDecl(t.ret, "r")} = ${call};`);
      d.push(`  if (scr_exc_pending()) return NULL;`);
      d.push(`  ScrDyn *out = ${toDynExprC(E, t.ret, "r")};`);
      if (isRefCounted(t.ret)) d.push(`  ${releaseCallC(t.ret, "r")};`);
      d.push(`  return out;`);
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The box builder dynFrom emits for one closure signature. */
  export function dynFuncBoxHelper(E: CEmitter, t: IrType & { kind: "func" }): string {
    const key = typeKey(t);
    const existing = E.dynFuncBoxes.get(key);
    if (existing) return existing;
    const name = `sc_dfb_${E.dynFuncBoxes.size}`;
    E.dynFuncBoxes.set(key, name);
    const sig = `static ScrDyn *${name}(ScrClosure *v, const char *fname)`;
    E.walkerProtos.push(`${sig}; /* box ${key} into dyn */`);
    const thunk = dynFuncThunkHelper(E, t);
    const sigLit = cStringLiteral(Buffer.from(key, "utf8"));
    E.walkerDefs.push(
      `${sig} { /* box ${key} into dyn */`,
      `  return scr_dyn_new_func(scr_closure_retain(v), &${thunk}, ${t.params.length}, ${sigLit}, fname);`,
      `}`,
      ``,
    );
    return name;
  }

/** The adapter closure body for one TARGET signature: the emitted C
   * function a func-targeted dynCheck wraps a non-identical boxed
   * signature in. caps[0] is an untraced obj-box owning the dyn function
   * value. */
  function dynFuncAdapterHelper(E: CEmitter, t: IrType & { kind: "func" }): string {
    const key = typeKey(t);
    const existing = E.dynFuncAdapters.get(key);
    if (existing) return existing;
    const name = `sc_dfa_${E.dynFuncAdapters.size}`;
    E.dynFuncAdapters.set(key, name);
    const params = ["ScrClosure *sc_env", ...t.params.map((p, i) => cDecl(p, `a${i}`))].join(", ");
    const sig = `static ${cType(t.ret)}${cType(t.ret).endsWith("*") ? "" : " "}${name}(${params})`;
    E.walkerProtos.push(`${sig}; /* dyn fn adapter to ${key} */`);
    const dummy =
      t.ret.kind === "void" ? "" : t.ret.kind === "f64" ? "0" : t.ret.kind === "bool" ? "false" : "NULL";
    const d: string[] = [`${sig} { /* dyn fn adapter to ${key} */`];
    d.push(`  ScrDyn *sc_fn = (ScrDyn *)scr_box_get_ref(sc_env->caps[0]); /* +1 */`);
    // The adapter OWNS its params (closure ABI); each converts to a dyn
    // argument (toDynExprC borrows) and releases.
    if (t.params.length > 0) {
      d.push(`  ScrDyn *sc_args[${t.params.length}];`);
      t.params.forEach((p, i) => {
        d.push(`  sc_args[${i}] = ${toDynExprC(E, p, `a${i}`)};`);
        if (isRefCounted(p)) d.push(`  ${releaseCallC(p, `a${i}`)};`);
      });
    }
    // The kind is FUNC by construction (the dynCheck that built this
    // adapter tested it), so `what` is unreachable — spelled anyway.
    d.push(
      `  ScrDyn *sc_r = scr_dyn_call(sc_fn, ${t.params.length > 0 ? "sc_args" : "NULL"}, ${t.params.length}, "value");`,
    );
    d.push(`  scr_dyn_release(sc_fn);`);
    t.params.forEach((_, i) => d.push(`  scr_dyn_release(sc_args[${i}]);`));
    d.push(`  if (scr_exc_pending()) return ${dummy};`.replace("return ;", "return;"));
    if (t.ret.kind === "void") {
      d.push(`  scr_dyn_release(sc_r);`);
      d.push(`  return;`);
    } else if (t.ret.kind === "dyn") {
      d.push(`  return sc_r;`);
    } else {
      // Validate the dyn result into the target's return type — a lying
      // wrapper throws the catchable TypeError here (path "$"), exactly
      // the dynCheck stance; the dummy result rides the pending unwind.
      d.push(`  ${cDecl(t.ret, "out")} = ${E.dynCheckHelper(t.ret)}(sc_r, NULL);`);
      d.push(`  scr_dyn_release(sc_r);`);
      d.push(`  return out;`);
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The emitted dynamic-keyed READ helper for one (shape, result type):
   * `static <T> sc_rkg_<n>(<struct> *r, ScrStr *k)` — declared fields
   * answer first (string comparisons in canonical order; the frontend
   * proved each surfaces as T: identity, a to-dyn conversion, or an
   * arm-into-union wrap), then the overflow map on index-signature shapes.
   * A MISSING key yields the undefined dyn value (T dyn), the undefined
   * arm (T undefined-armed union), or TRAPS with the key text (the array
   * OOB policy — the checker claimed T and no undefined is representable).
   * Borrows both; refcounted results are owned (+1). */
  export function recordKeyGetHelper(E: CEmitter, shapeId: string, t: IrType, overflowOnly = false): string {
    const key = `${shapeId}|${typeKey(t)}${overflowOnly ? "|ovf" : ""}`;
    const existing = E.recordKeyGetFns.get(key);
    if (existing) return existing;
    const shape = E.recordsById.get(shapeId);
    if (!shape) throw new InternalCompilerError(`emitter bug: keyed read of unknown shape ${shapeId}`);
    const name = `sc_rkg_${E.recordKeyGetFns.size}`;
    E.recordKeyGetFns.set(key, name);
    const struct = mangleRecordStruct(shapeId);
    const sig = `static ${cType(t)}${cType(t).endsWith("*") ? "" : " "}${name}(${struct} *r, ScrStr *k)`;
    E.walkerProtos.push(`${sig}; /* r[k] on ${shapeId} as ${typeKey(t)} */`);
    const d: string[] = [`${sig} { /* r[k] on ${shapeId} as ${typeKey(t)} */`];
    // How a value of type `vt` (a field, or the overflow hit) surfaces as T.
    const surface = (vt: IrType, expr: string, owned: boolean): string => {
      if (typeEquals(vt, t)) {
        return owned || !isRefCounted(vt) ? expr : retainCallC(vt, expr);
      }
      if (t.kind === "dyn") {
        // toDyn borrows — an owned operand would leak; callers pass borrowed.
        return `${E.toDynHelper(vt)}(${expr})`;
      }
      if (t.kind === "union") {
        const def = E.unionsById.get(t.unionId);
        const tag = def?.arms.findIndex((a) => typeEquals(a, vt)) ?? -1;
        if (tag < 0) throw new InternalCompilerError(`emitter bug: keyed read arm for ${typeKey(vt)} in ${typeKey(t)}`);
        if (vt.kind === "f64") return `scr_union_new_f64(${tag}, ${expr})`;
        if (vt.kind === "bool") return `scr_union_new_bool(${tag}, ${expr})`;
        const rc = vAdapters(vt);
        const payload = owned ? expr : retainCallC(vt, expr);
        return `scr_union_new_ref(${tag}, ${payload}, &${rc.retain}, &${rc.release}, ${E.traceArgC(vt)})`;
      }
      throw new InternalCompilerError(`emitter bug: keyed read cannot surface ${typeKey(vt)} as ${typeKey(t)}`);
    };
    // overflowOnly (a literal key naming no declared field): the declared
    // switch can never hit — only the overflow answers.
    for (const f of overflowOnly ? [] : shape.fields) {
      const lit = E.internLiteral(f.name);
      d.push(`  if (scr_str_eq(k, (ScrStr *)&${lit})) { /* ${f.name} */`);
      d.push(`    return ${surface(f.type, `r->${mangleField(f.name)}`, false)};`);
      d.push(`  }`);
    }
    const iv = shape.indexValue;
    if (iv) {
      const m = `r->${OVERFLOW_MEMBER}`;
      if (iv.kind === "f64" || iv.kind === "bool") {
        const acc = iv.kind === "f64" ? "f64" : "bool";
        d.push(`  ${cDecl(iv, "hit")};`);
        d.push(`  if (scr_map_get_str_${acc}(${m}, k, &hit)) {`);
        d.push(`    return ${surface(iv, "hit", true)};`);
        d.push(`  }`);
      } else {
        d.push(`  ${cDecl(iv, "hit")} = (${cType(iv).trim()})scr_map_get_str_ref(${m}, k);`);
        d.push(`  if (hit) {`);
        if (typeEquals(iv, t)) {
          d.push(`    return hit; /* get returned +1 */`);
        } else if (t.kind === "union") {
          d.push(`    return ${surface(iv, "hit", true)};`);
        } else {
          throw new InternalCompilerError(`emitter bug: keyed read overflow ${typeKey(iv)} as ${typeKey(t)}`);
        }
        d.push(`  }`);
      }
    }
    // The miss path.
    if (t.kind === "dyn") {
      d.push(`  return scr_dyn_retain(scr_dyn_undefined());`);
    } else if (t.kind === "union" && undefinedArmTag(t, E.unionsById) >= 0) {
      d.push(`  return ${E.unitInstanceRef(t.unionId, undefinedArmTag(t, E.unionsById))};`);
    } else {
      // JS would answer undefined; T has no way to say it (the checker
      // claimed T without noUncheckedIndexedAccess) — trap like an array
      // OOB read instead of corrupting a typed slot (SEMANTICS.md).
      d.push(`  scr_trap_fmt("scriptc: TypeError: record has no key '%.*s' (typed '${dynDesc(t, E.recordsById, E.unionsById)}' — no undefined is representable)\\n", (int)k->len, k->data);`);
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }

/** The emitted dynamic-keyed WRITE helper for one index-signature shape:
   * `static void sc_rks_<n>(<struct> *r, ScrStr *k, <V> v)` — a declared
   * key writes THROUGH to the struct slot (dyn values validate against the
   * field's type first via the dynCheck walker: a mismatch throws the
   * catchable TypeError and leaves the field untouched — JS would store
   * anything, the documented divergence; typed values store directly),
   * an undeclared key inserts/replaces in the overflow map. Borrows r and
   * k; OWNS v (+1 moves in — released on the validation-failure path). */
  export function recordKeySetHelper(E: CEmitter, shapeId: string): string {
    const existing = E.recordKeySetFns.get(shapeId);
    if (existing) return existing;
    const shape = E.recordsById.get(shapeId);
    // Signature-free shapes dispatch over their (one-typed) declared
    // fields and TRAP on a miss (scr_record_key_miss — JS would add the
    // property, which a monomorphic struct cannot); overflow shapes keep
    // the map insert tail.
    const iv = shape?.indexValue ?? shape?.fields[0]?.type;
    if (!shape || !iv) throw new InternalCompilerError(`emitter bug: keyed write on field-free non-overflow shape ${shapeId}`);
    const name = `sc_rks_${E.recordKeySetFns.size}`;
    E.recordKeySetFns.set(shapeId, name);
    const struct = mangleRecordStruct(shapeId);
    const sig = `static void ${name}(${struct} *r, ScrStr *k, ${cDecl(iv, "v")})`;
    E.walkerProtos.push(`${sig}; /* r[k] = v on ${shapeId} */`);
    const d: string[] = [`${sig} { /* r[k] = v on ${shapeId} */`];
    for (const f of shape.fields) {
      const lit = E.internLiteral(f.name);
      const member = `r->${mangleField(f.name)}`;
      d.push(`  if (scr_str_eq(k, (ScrStr *)&${lit})) { /* ${f.name} */`);
      if (iv.kind === "dyn" && shape.indexValue) {
        const keyLit = cStringLiteral(Buffer.from(f.name, "utf8"));
        d.push(`    ScrDynPath p = { NULL, ${keyLit}, 0 };`);
        d.push(`    ${cDecl(f.type, "nv")} = ${E.dynCheckHelper(f.type)}(v, &p);`);
        d.push(`    scr_dyn_release(v);`);
        d.push(`    if (scr_exc_pending()) return; /* mismatched write: TypeError, field untouched */`);
        d.push(`    ${isRefCounted(f.type) ? `if (${member}) ${releaseCallC(f.type, member)};` : `(void)0;`}`);
        d.push(`    ${member} = nv;`);
      } else {
        // typeEquals(f.type, iv) — the frontend fences everything else.
        if (isRefCounted(f.type)) {
          d.push(`    if (${member}) ${releaseCallC(f.type, member)};`);
        }
        d.push(`    ${member} = v;`);
      }
      d.push(`    return;`);
      d.push(`  }`);
    }
    if (!shape.indexValue) {
      // The MISS on a fixed shape: release the moved-in value, throw the
      // catchable TypeError naming the key (JS would add the property —
      // the documented monomorphic-struct divergence).
      if (isRefCounted(iv)) d.push(`  if (v) ${releaseCallC(iv, "v")};`);
      d.push(`  scr_record_key_miss(k);`);
    } else {
      const m = `r->${OVERFLOW_MEMBER}`;
      if (iv.kind === "f64" || iv.kind === "bool") {
        d.push(`  scr_map_set_str_${iv.kind === "f64" ? "f64" : "bool"}(${m}, k, v);`);
      } else {
        d.push(`  scr_map_set_str_ref(${m}, k, v); /* v moves in */`);
      }
    }
    d.push(`}`, ``);
    E.walkerDefs.push(...d);
    return name;
  }
