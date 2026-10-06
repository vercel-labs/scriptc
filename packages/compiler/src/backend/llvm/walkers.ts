import { f64Lit } from "./common.js";
import { InternalCompilerError } from "../../errors.js";
/* Structure-walking helper EMITTERS for the LLVM backend — the .ll mirror
 * of walkers.ts's phase-3 slice: type-directed JSON serializers over
 * the external scr_jb_* string builder (one emitted function per typeKey,
 * interned), the pretty-print re-indenter (Node's gap algorithm), and the
 * per-union ToString/join pair Array#join needs over union elements.
 * Interning ORDER is part of the emitted .ll, so the registries live on one
 * LlWalkers instance the emitter owns.
 *
 * Mostly throw-free; the ONE exception is circular-structure detection:
 * walkers over CYCLE-CAPABLE types (recursive records and their arrays)
 * bracket their bodies with scr_jb_enter/leave, and a cyclic value makes
 * enter set the pending TypeError and the walker chain return early — the
 * jsonStringify emission site runs the pending check (join still walks
 * only f64/string/bool/unit arms — the frontend's fence). */
import type { IrRecordShape, IrType, IrUnionDef } from "../../ir/ir.js";
import { isRefCounted, typeKey } from "../../ir/ir.js";
import { jsonObjectKeyLabel } from "../json-literal.js";
import { mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { llvmCommentText } from "./common.js";
import { llFieldType, releaseSym, traceAdapter, type ShapeHost } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { undefinedArmTag } from "../../ir/analysis.js";

/** What the walkers need from the emitter beyond the shape tables: union
 * defs, the undefined-arm probe, interned ScrStr literals (unit-arm
 * ToString), and NUL-terminated C-string constants (scr_jb_puts /
 * scr_error-style label texts). */
export interface WalkerHost extends ShapeHost {
  readonly unionsById: Map<string, IrUnionDef>;
  /** `@`-ref of an interned immortal ScrStr literal. */
  internLiteral(text: string): string;
  /** `@`-ref of an interned NUL-terminated byte-array constant. */
  cstr(text: string): string;
  /** Request the shared invalid-union-tag abort helper (@sc_bad_tag). */
  needBadTag(): void;
}

const FN_ATTRS = "#0";

export class LlWalkers {
  private readonly jsonWriters = new Map<string, string>();
  private readonly unionJoinFns = new Map<string, string>();
  /** Emitted function definitions, in interning order. */
  readonly defs: string[] = [];

  constructor(private readonly host: WalkerHost) {}

  private get S(): "i32" | "i64" {
    return this.host.sizeType;
  }
  private abiOffset(native64: number, wasm32: number): number {
    return this.S === "i32" ? wasm32 : native64;
  }

  /** The value-parameter LLVM type of a writer for `t`. */
  private valTy(t: IrType): string {
    return t.kind === "f64" ? "double" : t.kind === "bool" ? "i1" : "ptr";
  }

  /* ── the byte plumbing shared by every walker ─────────────────────────── */

  private putc(B: BlockBuilder, buf: string, byte: string): void {
    this.host.declare(`declare void @scr_jb_putc(ptr, i8)`);
    B.line(`call void @scr_jb_putc(ptr ${buf}, i8 ${byte})`);
  }

  private puts(B: BlockBuilder, buf: string, text: string): void {
    this.host.declare(`declare void @scr_jb_write(ptr, ptr, ${this.S})`);
    B.line(
      `call void @scr_jb_write(ptr ${buf}, ptr ${this.host.cstr(text)}, ${this.S} ${Buffer.byteLength(text, "utf8")}) ; ${JSON.stringify(text)}`,
    );
  }

  /** Appends a borrowed string, including embedded NUL bytes, in one write. */
  private putScrStr(B: BlockBuilder, buf: string, s: string): void {
    this.host.declare(`declare void @scr_jb_put_str(ptr, ptr)`);
    B.line(`call void @scr_jb_put_str(ptr ${buf}, ptr ${s})`);
  }

  /** Loads a union box's tag. */
  private unionTag(B: BlockBuilder, uName: string): string {
    const p = B.tmp();
    const t = B.tmp();
    B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 1`);
    B.line(`${t} = load i32, ptr ${p}`);
    return t;
  }

  private unionPeek(B: BlockBuilder, uName: string): string {
    const p = B.tmp();
    const t = B.tmp();
    B.line(`${p} = getelementptr inbounds %ScrUnion, ptr ${uName}, i64 0, i32 5`);
    B.line(`${t} = load ptr, ptr ${p}`);
    return t;
  }

  /* ── circular-structure detection (the C walkers' scr_jb_enter bracket,
   * ported): CYCLE-CAPABLE containers push themselves on the buffer's
   * seen stack; a repeat throws V8's exact circular TypeError inside
   * scr_jb_enter and the walker returns with the exception pending. ── */

  /** Emits the enter call + early return; caller pairs it with jbLeave. */
  private jbEnter(B: BlockBuilder, isArray: boolean): void {
    this.host.declare(`declare zeroext i1 @scr_jb_enter(ptr, ptr, i1)`);
    const ok = B.tmp();
    B.line(
      `${ok} = call zeroext i1 @scr_jb_enter(ptr %b, ptr %v, i1 ${isArray ? "true" : "false"})`,
    );
    const go = B.newLabel("jw.go");
    const circ = B.newLabel("jw.circ");
    B.condBr(ok, go, circ);
    B.startBlock(circ);
    B.terminate(`ret void ; circular: pending TypeError`);
    B.startBlock(go);
  }

  private jbLeave(B: BlockBuilder): void {
    this.host.declare(`declare void @scr_jb_leave(ptr)`);
    B.line(`call void @scr_jb_leave(ptr %b)`);
  }

  private jbEdgeProp(B: BlockBuilder, name: string): void {
    this.host.declare(`declare void @scr_jb_edge_prop(ptr, ptr)`);
    B.line(
      `call void @scr_jb_edge_prop(ptr %b, ptr ${this.host.cstr(name)}) ; ${JSON.stringify(name)}`,
    );
  }

  private jbEdgeIdx(B: BlockBuilder, idx: string): void {
    this.host.declare(`declare void @scr_jb_edge_idx(ptr, ${this.S})`);
    B.line(`call void @scr_jb_edge_idx(ptr %b, ${this.S} ${idx})`);
  }

  /* ── type-directed JSON serializers (jsonWriteHelper, ported) ─────────── */

  jsonWriteHelper(t: IrType): string {
    const key = typeKey(t);
    const existing = this.jsonWriters.get(key);
    if (existing) return existing;
    const name = `sc_jw_${this.jsonWriters.size}`;
    this.jsonWriters.set(key, name);
    const B = new BlockBuilder();
    switch (t.kind) {
      case "f64":
        this.host.declare(`declare void @scr_jb_put_f64(ptr, double)`);
        B.line(
          `call void @scr_jb_put_f64(ptr %b, double %v) ; NaN/Infinity -> null, -0 -> 0, like JS`,
        );
        break;
      case "bool": {
        const s = B.tmp();
        this.host.declare(`declare void @scr_jb_puts(ptr, ptr)`);
        B.line(
          `${s} = select i1 %v, ptr ${this.host.cstr("true")}, ptr ${this.host.cstr("false")}`,
        );
        B.line(`call void @scr_jb_puts(ptr %b, ptr ${s})`);
        break;
      }
      case "string":
        this.host.declare(`declare void @scr_jb_put_json_str(ptr, ptr)`);
        B.line(`call void @scr_jb_put_json_str(ptr %b, ptr %v)`);
        break;
      case "dyn":
        // Overflow values under an `unknown` index signature: the checked-dynamic tree
        // serializes itself (runtime walker). Bare stringify of dyn stays
        // frontend-fenced; this writer is reachable only through overflow
        // entries.
        this.host.declare(`declare void @scr_jb_put_dyn(ptr, ptr)`);
        B.line(`call void @scr_jb_put_dyn(ptr %b, ptr %v)`);
        break;
      case "record":
        this.emitRecordWriter(B, t.shapeId);
        break;
      case "array":
        this.emitArrayWriter(B, t.elem, traceAdapter(this.host, t) !== null);
        break;
      case "union":
        this.emitUnionWriter(B, t.unionId);
        break;
      default:
        throw new LlvmUnsupportedError(`jsonStringify:${t.kind}`);
    }
    B.terminate("ret void");
    this.defs.push(
      `define internal void @${name}(ptr %b, ${this.valTy(t)} %v) ${FN_ATTRS} { ; stringify ${key}`,
      B.render(),
      `}`,
      ``,
    );
    return name;
  }

  /** Loads a record field slot (i8-stored bools trunc to i1). */
  private loadField(
    B: BlockBuilder,
    recName: string,
    shapeId: string,
    index: number,
    t: IrType,
  ): string {
    const p = B.tmp();
    B.line(
      `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${recName}, i64 0, i32 ${index}`,
    );
    const fieldTy = llFieldType(t);
    const raw = B.tmp();
    B.line(`${raw} = load ${fieldTy}, ptr ${p}`);
    if (fieldTy !== "i8") return raw;
    const b = B.tmp();
    B.line(`${b} = trunc i8 ${raw} to i1`);
    return b;
  }

  private emitRecordWriter(B: BlockBuilder, shapeId: string): void {
    const shape = this.host.recordsById.get(shapeId);
    if (!shape)
      throw new InternalCompilerError(
        `llvm emitter bug: jsonStringify of unknown shape ${shapeId}`,
      );
    const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + 1]));
    // CYCLE-CAPABLE shapes bracket the walk with the circular-detection
    // stack; edge labels stamp before members whose walk can re-enter —
    // walkers.ts's contract, ported.
    const cyclic = traceAdapter(this.host, { kind: "record", shapeId }) !== null;
    const edgeable = (ft: IrType): boolean => cyclic && traceAdapter(this.host, ft) !== null;
    if (cyclic) this.jbEnter(B, shape.tuple === true);
    // A tuple serializes as a JSON ARRAY in index order — JS-exact. Every
    // position is required, so commas are static.
    if (shape.tuple) {
      const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
      this.putc(B, "%b", "91"); // '['
      byIndex.forEach((f, i) => {
        if (i > 0) this.putc(B, "%b", "44"); // ','
        if (edgeable(f.type)) this.jbEdgeIdx(B, String(i));
        const v = this.loadField(B, "%v", shapeId, fieldIndex.get(f.name)!, f.type);
        B.line(
          `call void @${this.jsonWriteHelper(f.type)}(ptr %b, ${this.valTy(f.type)} ${v}) ; [${llvmCommentText(f.name)}]`,
        );
      });
      this.putc(B, "%b", "93"); // ']'
      if (cyclic) this.jbLeave(B);
      return;
    }
    // Fields serialize in DECLARED order (JS insertion order); internal
    // '%'-fields stay hidden — jsonWriteHelper's contract, ported comment
    // and all.
    const order = shape.declaredOrder ?? shape.fields.map((f) => f.name);
    const inOrder = new Set(order);
    if (shape.fields.some((f) => !inOrder.has(f.name) && !f.name.startsWith("%"))) {
      throw new InternalCompilerError(
        `llvm emitter bug: declaredOrder of shape ${shapeId} omits a non-internal field`,
      );
    }
    const byName = new Map(shape.fields.map((f) => [f.name, f]));
    const emitFields = order.map((n) => byName.get(n)).filter((f) => f !== undefined);
    const droppable =
      emitFields.some((f) => undefinedArmTag(f.type, this.host.unionsById) >= 0) ||
      !!shape.indexValue;
    this.putc(B, "%b", "123"); // '{'
    if (!droppable) {
      emitFields.forEach((f, i) => {
        this.puts(B, "%b", `${i > 0 ? "," : ""}${jsonObjectKeyLabel(f.name)}`);
        if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
        const v = this.loadField(B, "%v", shapeId, fieldIndex.get(f.name)!, f.type);
        B.line(
          `call void @${this.jsonWriteHelper(f.type)}(ptr %b, ${this.valTy(f.type)} ${v}) ; ${llvmCommentText(f.name)}`,
        );
      });
    } else {
      const first = B.slot();
      B.entryAllocas.push(`${first} = alloca i1`);
      B.line(`store i1 true, ptr ${first}`);
      const comma = (): void => {
        const isf = B.tmp();
        const lc = B.newLabel("jwc.c");
        const lj = B.newLabel("jwc.j");
        B.line(`${isf} = load i1, ptr ${first}`);
        B.condBr(isf, lj, lc);
        B.startBlock(lc);
        this.putc(B, "%b", "44"); // ','
        B.br(lj);
        B.startBlock(lj);
        B.line(`store i1 false, ptr ${first}`);
      };
      for (const f of emitFields) {
        const utag = undefinedArmTag(f.type, this.host.unionsById);
        const v = this.loadField(B, "%v", shapeId, fieldIndex.get(f.name)!, f.type);
        let skip: string | null = null;
        if (utag >= 0) {
          // Undefined-valued field: dropped, like Node.
          const tag = this.unionTag(B, v);
          const isu = B.tmp();
          B.line(`${isu} = icmp eq i32 ${tag}, ${utag}`);
          const lw = B.newLabel("jwf.w");
          skip = B.newLabel("jwf.s");
          B.condBr(isu, skip, lw);
          B.startBlock(lw);
        }
        comma();
        this.puts(B, "%b", jsonObjectKeyLabel(f.name));
        if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
        B.line(
          `call void @${this.jsonWriteHelper(f.type)}(ptr %b, ${this.valTy(f.type)} ${v}) ; ${llvmCommentText(f.name)}`,
        );
        if (skip !== null) {
          B.br(skip);
          B.startBlock(skip);
        }
      }
      if (shape.indexValue) this.emitOverflowEntries(B, shape, first, edgeable(shape.indexValue));
    }
    this.putc(B, "%b", "125"); // '}'
    if (cyclic) this.jbLeave(B);
  }

  /** Overflow entries follow the declared fields, in JS OWN-KEY order
   * (scr_map_keys_js_order); keys escape like any JSON string;
   * undefined-valued entries drop (the optional-field rule). */
  private emitOverflowEntries(
    B: BlockBuilder,
    shape: IrRecordShape,
    first: string,
    edgeKeys = false,
  ): void {
    const iv = shape.indexValue!;
    const host = this.host;
    const ovfp = B.tmp();
    const ovf = B.tmp();
    B.line(
      `${ovfp} = getelementptr inbounds %${mangleRecordStruct(shape.id)}, ptr %v, i64 0, i32 ${shape.fields.length + 1}`,
    );
    B.line(`${ovf} = load ptr, ptr ${ovfp} ; overflow map`);
    host.declare(`declare ptr @scr_map_keys_js_order(ptr)`);
    host.declare(`declare double @scr_arr_len(ptr)`);
    host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
    host.declare(`declare void @scr_str_release(ptr)`);
    const ks = B.tmp();
    const len = B.tmp();
    B.line(`${ks} = call ptr @scr_map_keys_js_order(ptr ${ovf})`);
    B.line(`${len} = call double @scr_arr_len(ptr ${ks})`);
    B.countedLoop(len, (i, next) => {
      const k = B.tmp();
      B.line(`${k} = call ptr @scr_arr_get_ref(ptr ${ks}, double ${i}) ; key (+1)`);
      // The entry value, type-directed off the overflow VALUE type.
      let val: string;
      if (iv.kind === "f64" || iv.kind === "bool") {
        const outTy = iv.kind === "f64" ? "double" : "i8";
        const outSlot = B.slot();
        B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
        B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
        host.declare(
          `declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`,
        );
        const found = B.tmp();
        B.line(
          `${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${k}, ptr ${outSlot})`,
        );
        const raw = B.tmp();
        B.line(`${raw} = load ${outTy}, ptr ${outSlot}`);
        if (iv.kind === "bool") {
          val = B.tmp();
          B.line(`${val} = trunc i8 ${raw} to i1`);
        } else {
          val = raw;
        }
      } else {
        host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
        val = B.tmp();
        B.line(`${val} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${k}) ; value (+1)`);
      }
      // Undefined-valued entries drop, exactly the optional-field rule: a
      // dyn value whose dyn kind follows its size_t RC word (enum
      // member 6 — scr_runtime.h's ScrDynKind), or a union holding its
      // undefined arm.
      let skipUndef: string | null = null;
      if (iv.kind === "dyn") {
        const kp = B.tmp();
        const kd = B.tmp();
        const isu = B.tmp();
        B.line(
          `${kp} = getelementptr inbounds i8, ptr ${val}, i64 ${this.abiOffset(8, 4)} ; ->kind`,
        );
        B.line(`${kd} = load i32, ptr ${kp}`);
        B.line(
          `${isu} = icmp eq i32 ${kd}, 6 ; SCR_DYN_UNDEF (NULL is 0 — null members DO serialize)`,
        );
        skipUndef = isu;
      } else if (undefinedArmTag(iv, this.host.unionsById) >= 0) {
        const tag = this.unionTag(B, val);
        const isu = B.tmp();
        B.line(`${isu} = icmp eq i32 ${tag}, ${undefinedArmTag(iv, this.host.unionsById)}`);
        skipUndef = isu;
      }
      if (skipUndef !== null) {
        const ld = B.newLabel("ovf.d");
        const write = B.newLabel("ovf.w");
        B.condBr(skipUndef, ld, write);
        B.startBlock(ld);
        if (isRefCounted(iv)) B.line(`call void ${releaseSym(host, iv)}(ptr ${val})`);
        B.line(`call void @scr_str_release(ptr ${k})`);
        B.br(next);
        B.startBlock(write);
      }
      // The comma dance over the shared `first` flag.
      {
        const isf = B.tmp();
        const lcm = B.newLabel("ovf.cm");
        const lj = B.newLabel("ovf.cj");
        B.line(`${isf} = load i1, ptr ${first}`);
        B.condBr(isf, lj, lcm);
        B.startBlock(lcm);
        this.putc(B, "%b", "44"); // ','
        B.br(lj);
        B.startBlock(lj);
        B.line(`store i1 false, ptr ${first}`);
      }
      host.declare(`declare void @scr_jb_put_json_str(ptr, ptr)`);
      B.line(`call void @scr_jb_put_json_str(ptr %b, ptr ${k})`);
      this.putc(B, "%b", "58"); // ':'
      if (edgeKeys) {
        this.host.declare(`declare void @scr_jb_edge_key(ptr, ptr)`);
        B.line(`call void @scr_jb_edge_key(ptr %b, ptr ${k})`);
      }
      B.line(`call void @${this.jsonWriteHelper(iv)}(ptr %b, ${this.valTy(iv)} ${val})`);
      B.line(`call void @scr_str_release(ptr ${k})`);
      if (isRefCounted(iv)) B.line(`call void ${releaseSym(host, iv)}(ptr ${val})`);
    });
    host.declare(`declare void @scr_arr_release(ptr)`);
    B.line(`call void @scr_arr_release(ptr ${ks})`);
  }

  private emitArrayWriter(B: BlockBuilder, elem: IrType, cyclic: boolean): void {
    const host = this.host;
    const w = this.jsonWriteHelper(elem);
    host.declare(`declare double @scr_arr_len(ptr)`);
    // A cycle-capable array joins the circular-detection stack exactly
    // like a cycle-capable record.
    if (cyclic) this.jbEnter(B, true);
    this.putc(B, "%b", "91"); // '['
    const len = B.tmp();
    B.line(`${len} = call double @scr_arr_len(ptr %v)`);
    B.countedLoop(len, (i) => {
      const nz = B.tmp();
      const lcm = B.newLabel("jwa.cm");
      const lj = B.newLabel("jwa.cj");
      B.line(`${nz} = fcmp ogt double ${i}, ${f64Lit(0)}`);
      B.condBr(nz, lcm, lj);
      B.startBlock(lcm);
      this.putc(B, "%b", "44"); // ','
      B.br(lj);
      B.startBlock(lj);
      host.declare(`declare double @scr_arr_state(ptr, double)`);
      const state = B.tmp();
      const present = B.tmp();
      const valueBlock = B.newLabel("jwa.value");
      const missingBlock = B.newLabel("jwa.missing");
      const doneBlock = B.newLabel("jwa.done");
      B.line(`${state} = call double @scr_arr_state(ptr %v, double ${i})`);
      B.line(`${present} = fcmp oeq double ${state}, ${f64Lit(1)}`);
      B.condBr(present, valueBlock, missingBlock);
      B.startBlock(missingBlock);
      host.declare(`declare void @scr_jb_puts(ptr, ptr)`);
      B.line(`call void @scr_jb_puts(ptr %b, ptr ${host.cstr("null")})`);
      B.br(doneBlock);
      B.startBlock(valueBlock);
      if (cyclic) {
        const idx = B.tmp();
        B.line(`${idx} = fptoui double ${i} to ${this.S}`);
        this.jbEdgeIdx(B, idx);
      }
      if (elem.kind === "f64" || elem.kind === "bool") {
        const acc = elem.kind;
        const accTy = elem.kind === "f64" ? "double" : "i1";
        host.declare(
          `declare ${elem.kind === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`,
        );
        const v = B.tmp();
        B.line(`${v} = call ${accTy} @scr_arr_get_${acc}(ptr %v, double ${i})`);
        B.line(`call void @${w}(ptr %b, ${accTy} ${v})`);
      } else {
        // _get_ref returns +1; release after writing.
        host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
        const v = B.tmp();
        B.line(`${v} = call ptr @scr_arr_get_ref(ptr %v, double ${i})`);
        B.line(`call void @${w}(ptr %b, ptr ${v})`);
        B.line(`call void ${releaseSym(host, elem)}(ptr ${v})`);
      }
      B.br(doneBlock);
      B.startBlock(doneBlock);
    });
    this.putc(B, "%b", "93"); // ']'
    if (cyclic) this.jbLeave(B);
  }

  private emitUnionWriter(B: BlockBuilder, unionId: string): void {
    const def = this.host.unionsById.get(unionId);
    if (!def)
      throw new InternalCompilerError(
        `llvm emitter bug: jsonStringify of unknown union ${unionId}`,
      );
    const tag = this.unionTag(B, "%v");
    const bad = B.newLabel("jwu.bad");
    const done = B.newLabel("jwu.d");
    const labels = def.arms.map(() => B.newLabel("jwu.a"));
    B.terminate(
      `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    def.arms.forEach((arm, i) => {
      B.startBlock(labels[i]!);
      if (arm.kind === "nullT") {
        // Payload-less arm: JSON.stringify(null) is the text `null`.
        this.puts(B, "%b", "null");
        B.br(done);
        return;
      }
      if (arm.kind === "undefinedT") {
        // Array and tuple slots stringify undefined as null. Ordinary
        // record fields drop the key before invoking this writer.
        this.puts(B, "%b", "null");
        B.br(done);
        return;
      }
      const w = this.jsonWriteHelper(arm);
      if (arm.kind === "f64") {
        this.host.declare(`declare double @scr_union_get_f64(ptr)`);
        const x = B.tmp();
        B.line(`${x} = call double @scr_union_get_f64(ptr %v)`);
        B.line(`call void @${w}(ptr %b, double ${x})`);
      } else if (arm.kind === "bool") {
        this.host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
        const x = B.tmp();
        B.line(`${x} = call zeroext i1 @scr_union_get_bool(ptr %v)`);
        B.line(`call void @${w}(ptr %b, i1 ${x})`);
      } else {
        // Payload is BORROWED out of the box for the write.
        const p = this.unionPeek(B, "%v");
        B.line(`call void @${w}(ptr %b, ptr ${p}) ; ${arm.kind}`);
      }
      B.br(done);
    });
    B.startBlock(bad);
    this.host.needBadTag();
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
    B.startBlock(done);
  }

  /** The shared formatter borrows compact JSON and the frontend-resolved gap. */
  jsonIndentHelper(): string {
    this.host.declare(`declare ptr @scr_json_indent(ptr, ptr, ${this.S})`);
    return "scr_json_indent";
  }

  /* ── the per-union ToString / Array#join pair (ported) ────────────────── */

  /** Joining scalar unions invokes no user code. Borrow each payload from
   * the stable array and write it directly; nullish values remain empty. */
  unionJoinHelper(unionId: string): string {
    const existing = this.unionJoinFns.get(unionId);
    if (existing) return existing;
    const def = this.host.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`llvm emitter bug: join of unknown union ${unionId}`);
    const name = `sc_uj_${this.unionJoinFns.size}`;
    this.unionJoinFns.set(unionId, name);

    const host = this.host;
    host.declare(`declare void @scr_jb_init(ptr)`);
    host.declare(`declare ptr @scr_jb_finish(ptr)`);
    host.declare(`declare double @scr_arr_len(ptr)`);
    host.declare(`declare double @scr_arr_state(ptr, double)`);
    host.declare(`declare ptr @scr_arr_peek_ref(ptr, double) memory(read)`);
    const B = new BlockBuilder();
    const buf = "%jb";
    B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
    B.line(`call void @scr_jb_init(ptr ${buf})`);
    const len = B.tmp();
    B.line(`${len} = call double @scr_arr_len(ptr %a)`);
    B.countedLoop(len, (i, next) => {
      // `if (i) put sep bytes` — separators between elements only.
      const nz = B.tmp();
      const lsep = B.newLabel("uj.s");
      const lel = B.newLabel("uj.v");
      B.line(`${nz} = fcmp ogt double ${i}, ${f64Lit(0)}`);
      B.condBr(nz, lsep, lel);
      B.startBlock(lsep);
      this.putScrStr(B, buf, "%sep");
      B.br(lel);
      B.startBlock(lel);
      // Holes and payload-free present undefined both stringify empty. The
      // separator was already written for this logical index, and only a
      // VALUE slot may reach the typed getter below.
      const state = B.tmp();
      const isValue = B.tmp();
      const lvalue = B.newLabel("uj.p");
      B.line(`${state} = call double @scr_arr_state(ptr %a, double ${i})`);
      B.line(`${isValue} = fcmp oeq double ${state}, ${f64Lit(1)}`);
      B.condBr(isValue, lvalue, next);
      B.startBlock(lvalue);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_arr_peek_ref(ptr %a, double ${i}) ; borrowed scalar union`);
      const tag = this.unionTag(B, u);
      const bad = B.newLabel("uj.bad");
      const written = B.newLabel("uj.written");
      const labels = def.arms.map(() => B.newLabel("uj.arm"));
      B.terminate(
        `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, index) => `i32 ${index}, label %${labels[index]}`).join(" ")} ]`,
      );
      def.arms.forEach((arm, index) => {
        B.startBlock(labels[index]!);
        switch (arm.kind) {
          case "undefinedT":
          case "nullT":
            break;
          case "string":
            this.putScrStr(B, buf, this.unionPeek(B, u));
            break;
          case "f64": {
            host.declare(`declare double @scr_union_get_f64(ptr)`);
            host.declare(`declare void @scr_jb_put_number(ptr, double)`);
            const value = B.tmp();
            B.line(`${value} = call double @scr_union_get_f64(ptr ${u})`);
            B.line(`call void @scr_jb_put_number(ptr ${buf}, double ${value})`);
            break;
          }
          case "bool": {
            host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
            host.declare(`declare void @scr_jb_write(ptr, ptr, ${this.S})`);
            const value = B.tmp();
            const text = B.tmp();
            const length = B.tmp();
            B.line(`${value} = call zeroext i1 @scr_union_get_bool(ptr ${u})`);
            B.line(
              `${text} = select i1 ${value}, ptr ${host.cstr("true")}, ptr ${host.cstr("false")}`,
            );
            B.line(`${length} = select i1 ${value}, ${this.S} 4, ${this.S} 5`);
            B.line(`call void @scr_jb_write(ptr ${buf}, ptr ${text}, ${this.S} ${length})`);
            break;
          }
          default:
            throw new LlvmUnsupportedError(`unionJoin:${arm.kind}`);
        }
        B.br(written);
      });
      B.startBlock(bad);
      host.needBadTag();
      B.line(`call void @sc_bad_tag()`);
      B.terminate(`unreachable`);
      B.startBlock(written);
    });
    const r = B.tmp();
    B.line(`${r} = call ptr @scr_jb_finish(ptr ${buf})`);
    B.terminate(`ret ptr ${r}`);
    this.defs.push(
      `define internal ptr @${name}(ptr %a, ptr %sep) ${FN_ATTRS} { ; Array#join over ${unionId}: nullish arms print empty`,
      B.render(),
      `}`,
      ``,
    );
    return name;
  }
}
