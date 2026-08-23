import { InternalCompilerError } from "../../errors.js";
/* Structure-walking helper EMITTERS for the LLVM backend — the .ll mirror
 * of emit-walkers.ts's phase-3 slice: type-directed JSON serializers over
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
import type { IrRecordShape, IrType, IrUnionDef } from "../../ir/nodes.js";
import { isRefCounted, typeKey } from "../../ir/nodes.js";
import { mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { llFieldType, releaseSym, traceAdapter, type ShapeHost } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";

/** What the walkers need from the emitter beyond the shape tables: union
 * defs, the undefined-arm probe, interned ScrStr literals (unit-arm
 * ToString), and NUL-terminated C-string constants (scr_jb_puts /
 * scr_error-style label texts). */
export interface WalkerHost extends ShapeHost {
  readonly unionsById: Map<string, IrUnionDef>;
  undefinedArmTag(t: IrType): number;
  /** `@`-ref of an interned immortal ScrStr literal. */
  internLiteral(text: string): string;
  /** `@`-ref of an interned NUL-terminated byte-array constant. */
  cstr(text: string): string;
  /** Request the shared invalid-union-tag abort helper (@sc_bad_tag). */
  needBadTag(): void;
}

/** Exact double literal (the emitter's f64Lit — duplicated to avoid a
 * cyclic import; both spell every bit pattern identically). */
function f64Lit(n: number): string {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const FN_ATTRS = "#0";

export class LlWalkers {
  private readonly jsonWriters = new Map<string, string>();
  private readonly unionToStrFns = new Map<string, string>();
  private readonly unionJoinFns = new Map<string, string>();
  private indentFn: string | null = null;
  /** Emitted function definitions, in interning order. */
  readonly defs: string[] = [];

  constructor(private readonly host: WalkerHost) {}

  private get S(): "i32" | "i64" { return this.host.sizeType; }
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
    this.host.declare(`declare void @scr_jb_puts(ptr, ptr)`);
    B.line(`call void @scr_jb_puts(ptr ${buf}, ptr ${this.host.cstr(text)}) ; ${JSON.stringify(text)}`);
  }

  /** Appends an ScrStr's bytes: for (j < s->len) putc(s->data[j]). */
  private putScrStr(B: BlockBuilder, buf: string, s: string): void {
    const lenp = B.tmp();
    const len = B.tmp();
    const data = B.tmp();
    B.line(`${lenp} = getelementptr inbounds %ScrStr, ptr ${s}, i64 0, i32 1`);
    B.line(`${len} = load ${this.S}, ptr ${lenp}`);
    B.line(`${data} = getelementptr inbounds i8, ptr ${s}, i64 ${this.abiOffset(24, 12)} ; ->data`);
    const jSlot = B.slot();
    B.entryAllocas.push(`${jSlot} = alloca ${this.S}`);
    B.line(`store ${this.S} 0, ptr ${jSlot}`);
    const lc = B.newLabel("ps.c");
    const lb = B.newLabel("ps.b");
    const le = B.newLabel("ps.e");
    B.br(lc);
    B.startBlock(lc);
    const j = B.tmp();
    const cont = B.tmp();
    B.line(`${j} = load ${this.S}, ptr ${jSlot}`);
    B.line(`${cont} = icmp ult ${this.S} ${j}, ${len}`);
    B.condBr(cont, lb, le);
    B.startBlock(lb);
    const cp = B.tmp();
    const c = B.tmp();
    B.line(`${cp} = getelementptr inbounds i8, ptr ${data}, ${this.S} ${j}`);
    B.line(`${c} = load i8, ptr ${cp}`);
    this.putc(B, buf, c);
    const j2 = B.tmp();
    B.line(`${j2} = add ${this.S} ${j}, 1`);
    B.line(`store ${this.S} ${j2}, ptr ${jSlot}`);
    B.br(lc);
    B.startBlock(le);
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
    B.line(`${ok} = call zeroext i1 @scr_jb_enter(ptr %b, ptr %v, i1 ${isArray ? "true" : "false"})`);
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
    B.line(`call void @scr_jb_edge_prop(ptr %b, ptr ${this.host.cstr(name)}) ; ${JSON.stringify(name)}`);
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
        B.line(`call void @scr_jb_put_f64(ptr %b, double %v) ; NaN/Infinity -> null, -0 -> 0, like JS`);
        break;
      case "bool": {
        const s = B.tmp();
        this.host.declare(`declare void @scr_jb_puts(ptr, ptr)`);
        B.line(`${s} = select i1 %v, ptr ${this.host.cstr("true")}, ptr ${this.host.cstr("false")}`);
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
  private loadField(B: BlockBuilder, recName: string, shapeId: string, index: number, t: IrType): string {
    const p = B.tmp();
    B.line(`${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${recName}, i64 0, i32 ${index}`);
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
    if (!shape) throw new InternalCompilerError(`llvm emitter bug: jsonStringify of unknown shape ${shapeId}`);
    const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + 1]));
    // CYCLE-CAPABLE shapes bracket the walk with the circular-detection
    // stack; edge labels stamp before members whose walk can re-enter —
    // emit-walkers.ts's contract, ported.
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
        B.line(`call void @${this.jsonWriteHelper(f.type)}(ptr %b, ${this.valTy(f.type)} ${v}) ; [${f.name}]`);
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
      throw new InternalCompilerError(`llvm emitter bug: declaredOrder of shape ${shapeId} omits a non-internal field`);
    }
    const byName = new Map(shape.fields.map((f) => [f.name, f]));
    const emitFields = order.map((n) => byName.get(n)).filter((f) => f !== undefined);
    const droppable =
      emitFields.some((f) => this.host.undefinedArmTag(f.type) >= 0) || !!shape.indexValue;
    this.putc(B, "%b", "123"); // '{'
    if (!droppable) {
      emitFields.forEach((f, i) => {
        this.puts(B, "%b", `${i > 0 ? "," : ""}"${f.name}":`);
        if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
        const v = this.loadField(B, "%v", shapeId, fieldIndex.get(f.name)!, f.type);
        B.line(`call void @${this.jsonWriteHelper(f.type)}(ptr %b, ${this.valTy(f.type)} ${v}) ; ${f.name}`);
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
        const utag = this.host.undefinedArmTag(f.type);
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
        this.puts(B, "%b", `"${f.name}":`);
        if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
        B.line(`call void @${this.jsonWriteHelper(f.type)}(ptr %b, ${this.valTy(f.type)} ${v}) ; ${f.name}`);
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
  private emitOverflowEntries(B: BlockBuilder, shape: IrRecordShape, first: string, edgeKeys = false): void {
    const iv = shape.indexValue!;
    const host = this.host;
    const ovfp = B.tmp();
    const ovf = B.tmp();
    B.line(`${ovfp} = getelementptr inbounds %${mangleRecordStruct(shape.id)}, ptr %v, i64 0, i32 ${shape.fields.length + 1}`);
    B.line(`${ovf} = load ptr, ptr ${ovfp} ; overflow map`);
    host.declare(`declare ptr @scr_map_keys_js_order(ptr)`);
    host.declare(`declare double @scr_arr_len(ptr)`);
    host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
    host.declare(`declare void @scr_str_release(ptr)`);
    const ks = B.tmp();
    const len = B.tmp();
    B.line(`${ks} = call ptr @scr_map_keys_js_order(ptr ${ovf})`);
    B.line(`${len} = call double @scr_arr_len(ptr ${ks})`);
    const iSlot = B.slot();
    B.entryAllocas.push(`${iSlot} = alloca double`);
    B.line(`store double ${f64Lit(0)}, ptr ${iSlot}`);
    const lc = B.newLabel("ovf.c");
    const lb = B.newLabel("ovf.b");
    const ln = B.newLabel("ovf.n");
    const le = B.newLabel("ovf.e");
    B.br(lc);
    B.startBlock(lc);
    const i = B.tmp();
    const cont = B.tmp();
    B.line(`${i} = load double, ptr ${iSlot}`);
    B.line(`${cont} = fcmp olt double ${i}, ${len}`);
    B.condBr(cont, lb, le);
    B.startBlock(lb);
    const k = B.tmp();
    B.line(`${k} = call ptr @scr_arr_get_ref(ptr ${ks}, double ${i}) ; key (+1)`);
    // The entry value, type-directed off the overflow VALUE type.
    let val: string;
    if (iv.kind === "f64" || iv.kind === "bool") {
      const outTy = iv.kind === "f64" ? "double" : "i8";
      const outSlot = B.slot();
      B.entryAllocas.push(`${outSlot} = alloca ${outTy}`);
      B.line(`store ${outTy} ${iv.kind === "f64" ? f64Lit(0) : "0"}, ptr ${outSlot}`);
      host.declare(`declare zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr, ptr, ptr)`);
      const found = B.tmp();
      B.line(`${found} = call zeroext i1 @scr_map_get_str_${iv.kind === "f64" ? "f64" : "bool"}(ptr ${ovf}, ptr ${k}, ptr ${outSlot})`);
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
      B.line(`${kp} = getelementptr inbounds i8, ptr ${val}, i64 ${this.abiOffset(8, 4)} ; ->kind`);
      B.line(`${kd} = load i32, ptr ${kp}`);
      B.line(`${isu} = icmp eq i32 ${kd}, 6 ; SCR_DYN_UNDEF (NULL is 0 — null members DO serialize)`);
      skipUndef = isu;
    } else if (this.host.undefinedArmTag(iv) >= 0) {
      const tag = this.unionTag(B, val);
      const isu = B.tmp();
      B.line(`${isu} = icmp eq i32 ${tag}, ${this.host.undefinedArmTag(iv)}`);
      skipUndef = isu;
    }
    if (skipUndef !== null) {
      const ld = B.newLabel("ovf.d");
      const write = B.newLabel("ovf.w");
      B.condBr(skipUndef, ld, write);
      B.startBlock(ld);
      if (isRefCounted(iv)) B.line(`call void ${releaseSym(host, iv)}(ptr ${val})`);
      B.line(`call void @scr_str_release(ptr ${k})`);
      B.br(ln);
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
    B.br(ln);
    B.startBlock(ln);
    const i2 = B.tmp();
    B.line(`${i2} = fadd double ${i}, ${f64Lit(1)}`);
    B.line(`store double ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
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
    const iSlot = B.slot();
    B.entryAllocas.push(`${iSlot} = alloca double`);
    B.line(`store double ${f64Lit(0)}, ptr ${iSlot}`);
    const lc = B.newLabel("jwa.c");
    const lb = B.newLabel("jwa.b");
    const le = B.newLabel("jwa.e");
    B.br(lc);
    B.startBlock(lc);
    const i = B.tmp();
    const cont = B.tmp();
    B.line(`${i} = load double, ptr ${iSlot}`);
    B.line(`${cont} = fcmp olt double ${i}, ${len}`);
    B.condBr(cont, lb, le);
    B.startBlock(lb);
    const nz = B.tmp();
    const lcm = B.newLabel("jwa.cm");
    const lj = B.newLabel("jwa.cj");
    B.line(`${nz} = fcmp ogt double ${i}, ${f64Lit(0)}`);
    B.condBr(nz, lcm, lj);
    B.startBlock(lcm);
    this.putc(B, "%b", "44"); // ','
    B.br(lj);
    B.startBlock(lj);
    if (cyclic) {
      const idx = B.tmp();
      B.line(`${idx} = fptoui double ${i} to ${this.S}`);
      this.jbEdgeIdx(B, idx);
    }
    if (elem.kind === "f64" || elem.kind === "bool") {
      const acc = elem.kind;
      const accTy = elem.kind === "f64" ? "double" : "i1";
      host.declare(`declare ${elem.kind === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`);
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
    const i2 = B.tmp();
    B.line(`${i2} = fadd double ${i}, ${f64Lit(1)}`);
    B.line(`store double ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
    this.putc(B, "%b", "93"); // ']'
    if (cyclic) this.jbLeave(B);
  }

  private emitUnionWriter(B: BlockBuilder, unionId: string): void {
    const def = this.host.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`llvm emitter bug: jsonStringify of unknown union ${unionId}`);
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
        // Reachable only as a record FIELD's serializer, and the record
        // writer drops the field while it holds this tag before calling —
        // so the tag can never arrive here.
        B.br(bad);
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

  /* ── the pretty-print re-indenter (jsonIndentHelper, ported) ──────────── */

  /** `JSON.stringify(v, null, space)` as a REWRITE of the compact text —
   * Node's gap algorithm exactly (see emit-walkers.ts's sc_ji). The indent
   * rides as a NUL-terminated constant + byte length. */
  jsonIndentHelper(): string {
    if (this.indentFn) return this.indentFn;
    const name = "sc_ji";
    this.indentFn = name;
    const host = this.host;
    host.declare(`declare void @scr_jb_init(ptr)`);
    host.declare(`declare ptr @scr_jb_finish(ptr)`);
    host.declare(`declare void @scr_jb_putc(ptr, i8)`);

    // The newline + depth * indent writer, shared by the three break sites.
    this.defs.push(
      `define internal void @sc_ji_ind(ptr %b, ${this.S} %depth, ptr %ind, ${this.S} %ilen) ${FN_ATTRS} { ; stringify gap indent`,
      `entry:`,
      `  call void @scr_jb_putc(ptr %b, i8 10)`,
      `  br label %oc`,
      `oc:`,
      `  %d = phi ${this.S} [ 0, %entry ], [ %d2, %ie ]`,
      `  %ocont = icmp ult ${this.S} %d, %depth`,
      `  br i1 %ocont, label %ic0, label %done`,
      `ic0:`,
      `  br label %ic`,
      `ic:`,
      `  %k = phi ${this.S} [ 0, %ic0 ], [ %k2, %ib ]`,
      `  %icont = icmp ult ${this.S} %k, %ilen`,
      `  br i1 %icont, label %ib, label %ie`,
      `ib:`,
      `  %cp = getelementptr inbounds i8, ptr %ind, ${this.S} %k`,
      `  %c = load i8, ptr %cp`,
      `  call void @scr_jb_putc(ptr %b, i8 %c)`,
      `  %k2 = add ${this.S} %k, 1`,
      `  br label %ic`,
      `ie:`,
      `  %d2 = add ${this.S} %d, 1`,
      `  br label %oc`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
    );

    const B = new BlockBuilder();
    const buf = "%jb";
    B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
    const depth = "%depth";
    const instr = "%instr";
    const iSlot = "%i";
    B.entryAllocas.push(`${depth} = alloca ${this.S}`, `${instr} = alloca i1`, `${iSlot} = alloca ${this.S}`);
    B.line(`call void @scr_jb_init(ptr ${buf})`);
    B.line(`store ${this.S} 0, ptr ${depth}`);
    B.line(`store i1 false, ptr ${instr}`);
    B.line(`store ${this.S} 0, ptr ${iSlot}`);
    const np = B.tmp();
    const n = B.tmp();
    const data = B.tmp();
    B.line(`${np} = getelementptr inbounds %ScrStr, ptr %compact, i64 0, i32 1`);
    B.line(`${n} = load ${this.S}, ptr ${np}`);
    B.line(`${data} = getelementptr inbounds i8, ptr %compact, i64 ${this.abiOffset(24, 12)} ; ->data`);

    const loop = B.newLabel("ji.c");
    const body = B.newLabel("ji.b");
    const inc = B.newLabel("ji.n");
    const end = B.newLabel("ji.e");
    B.br(loop);
    B.startBlock(loop);
    const i = B.tmp();
    const cont = B.tmp();
    B.line(`${i} = load ${this.S}, ptr ${iSlot}`);
    B.line(`${cont} = icmp ult ${this.S} ${i}, ${n}`);
    B.condBr(cont, body, end);
    B.startBlock(body);
    const cp = B.tmp();
    const c = B.tmp();
    B.line(`${cp} = getelementptr inbounds i8, ptr ${data}, ${this.S} ${i}`);
    B.line(`${c} = load i8, ptr ${cp}`);
    const ins = B.tmp();
    B.line(`${ins} = load i1, ptr ${instr}`);
    const inStr = B.newLabel("ji.s");
    const outStr = B.newLabel("ji.o");
    B.condBr(ins, inStr, outStr);

    // In-string state: emit verbatim, skip the escaped char, leave on '"'.
    B.startBlock(inStr);
    this.putc(B, buf, c);
    const isbs = B.tmp();
    const i1p = B.tmp();
    const hasNext = B.tmp();
    const escTake = B.tmp();
    B.line(`${isbs} = icmp eq i8 ${c}, 92 ; backslash`);
    B.line(`${i1p} = add ${this.S} ${i}, 1`);
    B.line(`${hasNext} = icmp ult ${this.S} ${i1p}, ${n}`);
    B.line(`${escTake} = and i1 ${isbs}, ${hasNext}`);
    const esc = B.newLabel("ji.se");
    const noesc = B.newLabel("ji.sq");
    B.condBr(escTake, esc, noesc);
    B.startBlock(esc);
    const ecp = B.tmp();
    const ec = B.tmp();
    B.line(`${ecp} = getelementptr inbounds i8, ptr ${data}, ${this.S} ${i1p}`);
    B.line(`${ec} = load i8, ptr ${ecp}`);
    this.putc(B, buf, ec);
    B.line(`store ${this.S} ${i1p}, ptr ${iSlot} ; consumed the escaped char`);
    B.br(inc);
    B.startBlock(noesc);
    const isq = B.tmp();
    const stay = B.tmp();
    B.line(`${isq} = icmp eq i8 ${c}, 34 ; '"'`);
    B.line(`${stay} = xor i1 ${isq}, true`);
    B.line(`store i1 ${stay}, ptr ${instr}`);
    B.br(inc);

    // Out of string: the character switch.
    B.startBlock(outStr);
    const lQuote = B.newLabel("ji.q");
    const lOpenB = B.newLabel("ji.ob");
    const lOpenK = B.newLabel("ji.ok");
    const lClose = B.newLabel("ji.cl");
    const lComma = B.newLabel("ji.cm");
    const lColon = B.newLabel("ji.co");
    const lOther = B.newLabel("ji.ot");
    B.terminate(
      `switch i8 ${c}, label %${lOther} [ i8 34, label %${lQuote} i8 123, label %${lOpenB} i8 91, label %${lOpenK} ` +
        `i8 125, label %${lClose} i8 93, label %${lClose} i8 44, label %${lComma} i8 58, label %${lColon} ]`,
    );
    B.startBlock(lQuote);
    B.line(`store i1 true, ptr ${instr}`);
    this.putc(B, buf, c);
    B.br(inc);

    // '{' / '[': emit, then `{}`/`[]` stay inline (like Node) or a break
    // one level deeper.
    const openBody = (label: string, closer: number): void => {
      B.startBlock(label);
      this.putc(B, buf, c);
      const i1b = B.tmp();
      const hasNextB = B.tmp();
      B.line(`${i1b} = add ${this.S} ${i}, 1`);
      B.line(`${hasNextB} = icmp ult ${this.S} ${i1b}, ${n}`);
      const chk = B.newLabel("ji.opc");
      const deep = B.newLabel("ji.opd");
      const inline = B.newLabel("ji.opi");
      B.condBr(hasNextB, chk, deep);
      B.startBlock(chk);
      const ncp = B.tmp();
      const nc = B.tmp();
      const isClose = B.tmp();
      B.line(`${ncp} = getelementptr inbounds i8, ptr ${data}, ${this.S} ${i1b}`);
      B.line(`${nc} = load i8, ptr ${ncp}`);
      B.line(`${isClose} = icmp eq i8 ${nc}, ${closer}`);
      B.condBr(isClose, inline, deep);
      B.startBlock(inline);
      const nc2p = B.tmp();
      const nc2 = B.tmp();
      B.line(`${nc2p} = getelementptr inbounds i8, ptr ${data}, ${this.S} ${i1b}`);
      B.line(`${nc2} = load i8, ptr ${nc2p}`);
      this.putc(B, buf, nc2);
      B.line(`store ${this.S} ${i1b}, ptr ${iSlot} ; empty {} / [] stay inline, like Node`);
      B.br(inc);
      B.startBlock(deep);
      const d0 = B.tmp();
      const d1 = B.tmp();
      B.line(`${d0} = load ${this.S}, ptr ${depth}`);
      B.line(`${d1} = add ${this.S} ${d0}, 1`);
      B.line(`store ${this.S} ${d1}, ptr ${depth}`);
      B.line(`call void @sc_ji_ind(ptr ${buf}, ${this.S} ${d1}, ptr %ind, ${this.S} %ilen)`);
      B.br(inc);
    };
    openBody(lOpenB, 125); // '{' closes with '}'
    openBody(lOpenK, 93); // '[' closes with ']'

    B.startBlock(lClose);
    const dc0 = B.tmp();
    const dc1 = B.tmp();
    B.line(`${dc0} = load ${this.S}, ptr ${depth}`);
    B.line(`${dc1} = sub ${this.S} ${dc0}, 1`);
    B.line(`store ${this.S} ${dc1}, ptr ${depth}`);
    B.line(`call void @sc_ji_ind(ptr ${buf}, ${this.S} ${dc1}, ptr %ind, ${this.S} %ilen)`);
    this.putc(B, buf, c);
    B.br(inc);

    B.startBlock(lComma);
    this.putc(B, buf, "44");
    const dm = B.tmp();
    B.line(`${dm} = load ${this.S}, ptr ${depth}`);
    B.line(`call void @sc_ji_ind(ptr ${buf}, ${this.S} ${dm}, ptr %ind, ${this.S} %ilen)`);
    B.br(inc);

    B.startBlock(lColon);
    this.putc(B, buf, "58");
    this.putc(B, buf, "32"); // ' '
    B.br(inc);

    B.startBlock(lOther);
    this.putc(B, buf, c);
    B.br(inc);

    B.startBlock(inc);
    const iN = B.tmp();
    const iN2 = B.tmp();
    B.line(`${iN} = load ${this.S}, ptr ${iSlot}`);
    B.line(`${iN2} = add ${this.S} ${iN}, 1`);
    B.line(`store ${this.S} ${iN2}, ptr ${iSlot}`);
    B.br(loop);
    B.startBlock(end);
    const r = B.tmp();
    B.line(`${r} = call ptr @scr_jb_finish(ptr ${buf})`);
    B.terminate(`ret ptr ${r}`);

    this.defs.push(
      `define internal ptr @${name}(ptr %compact, ptr %ind, ${this.S} %ilen) ${FN_ATTRS} { ; stringify space re-indent (Node's gap algorithm)`,
      B.render(),
      `}`,
      ``,
    );
    return name;
  }

  /* ── the per-union ToString / Array#join pair (ported) ────────────────── */

  /** The per-union ToString helper: unit arms return the interned
   * "undefined"/"null" texts, string arms retain the payload, f64/bool
   * arms format (String(x) semantics). Ref arms never arrive (frontend
   * fence). Borrows the operand; the result is owned (+1). */
  unionToStrHelper(unionId: string): string {
    const existing = this.unionToStrFns.get(unionId);
    if (existing) return existing;
    const def = this.host.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`llvm emitter bug: ToString of unknown union ${unionId}`);
    const name = `sc_us_${this.unionToStrFns.size}`;
    this.unionToStrFns.set(unionId, name);
    const host = this.host;
    const B = new BlockBuilder();
    const tag = this.unionTag(B, "%v");
    const bad = B.newLabel("us.bad");
    const labels = def.arms.map(() => B.newLabel("us.a"));
    B.terminate(
      `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    def.arms.forEach((arm, i) => {
      B.startBlock(labels[i]!);
      switch (arm.kind) {
        case "undefinedT":
        case "nullT": {
          const lit = host.internLiteral(arm.kind === "undefinedT" ? "undefined" : "null");
          host.declare(`declare ptr @scr_str_retain_v(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call ptr @scr_str_retain_v(ptr ${lit})`);
          B.terminate(`ret ptr ${r}`);
          break;
        }
        case "string": {
          const p = this.unionPeek(B, "%v");
          host.declare(`declare ptr @scr_str_retain_v(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call ptr @scr_str_retain_v(ptr ${p})`);
          B.terminate(`ret ptr ${r}`);
          break;
        }
        case "f64": {
          host.declare(`declare double @scr_union_get_f64(ptr)`);
          host.declare(`declare ptr @scr_f64_to_scrstr(double)`);
          const x = B.tmp();
          const r = B.tmp();
          B.line(`${x} = call double @scr_union_get_f64(ptr %v)`);
          B.line(`${r} = call ptr @scr_f64_to_scrstr(double ${x})`);
          B.terminate(`ret ptr ${r}`);
          break;
        }
        case "bool": {
          host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
          host.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
          const x = B.tmp();
          const r = B.tmp();
          B.line(`${x} = call zeroext i1 @scr_union_get_bool(ptr %v)`);
          B.line(`${r} = call ptr @scr_bool_to_scrstr(i1 zeroext ${x})`);
          B.terminate(`ret ptr ${r}`);
          break;
        }
        default:
          throw new LlvmUnsupportedError(`unionToStr:${arm.kind}`);
      }
    });
    B.startBlock(bad);
    host.needBadTag();
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
    this.defs.push(
      `define internal ptr @${name}(ptr %v) ${FN_ATTRS} { ; ToString ${unionId}`,
      B.render(),
      `}`,
      ``,
    );
    return name;
  }

  /** Array.prototype.join over union elements: undefined/null arms print
   * EMPTY (exactly JS's join), every other arm goes through the per-union
   * ToString walker. Borrows the array and separator; result +1. */
  unionJoinHelper(unionId: string): string {
    const existing = this.unionJoinFns.get(unionId);
    if (existing) return existing;
    const def = this.host.unionsById.get(unionId);
    if (!def) throw new InternalCompilerError(`llvm emitter bug: join of unknown union ${unionId}`);
    const name = `sc_uj_${this.unionJoinFns.size}`;
    this.unionJoinFns.set(unionId, name);
    const toStr = this.unionToStrHelper(unionId);
    const unitTags = def.arms.flatMap((a, i) => (a.kind === "undefinedT" || a.kind === "nullT" ? [i] : []));
    const host = this.host;
    host.declare(`declare void @scr_jb_init(ptr)`);
    host.declare(`declare ptr @scr_jb_finish(ptr)`);
    host.declare(`declare double @scr_arr_len(ptr)`);
    host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
    host.declare(`declare void @scr_union_release(ptr)`);
    host.declare(`declare void @scr_str_release(ptr)`);
    const B = new BlockBuilder();
    const buf = "%jb";
    const iSlot = "%i";
    B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`, `${iSlot} = alloca double`);
    B.line(`call void @scr_jb_init(ptr ${buf})`);
    B.line(`store double ${f64Lit(0)}, ptr ${iSlot}`);
    const len = B.tmp();
    B.line(`${len} = call double @scr_arr_len(ptr %a)`);
    const lc = B.newLabel("uj.c");
    const lb = B.newLabel("uj.b");
    const ln = B.newLabel("uj.n");
    const le = B.newLabel("uj.e");
    B.br(lc);
    B.startBlock(lc);
    const i = B.tmp();
    const cont = B.tmp();
    B.line(`${i} = load double, ptr ${iSlot}`);
    B.line(`${cont} = fcmp olt double ${i}, ${len}`);
    B.condBr(cont, lb, le);
    B.startBlock(lb);
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
    const u = B.tmp();
    B.line(`${u} = call ptr @scr_arr_get_ref(ptr %a, double ${i}) ; element (+1)`);
    if (unitTags.length > 0) {
      // Nullish arms print empty, exactly JS's join.
      const tag = this.unionTag(B, u);
      let acc = "";
      for (const t of unitTags) {
        const cnd = B.tmp();
        B.line(`${cnd} = icmp eq i32 ${tag}, ${t}`);
        if (acc === "") {
          acc = cnd;
        } else {
          const o = B.tmp();
          B.line(`${o} = or i1 ${acc}, ${cnd}`);
          acc = o;
        }
      }
      const lskip = B.newLabel("uj.k");
      const lwrite = B.newLabel("uj.w");
      B.condBr(acc, lskip, lwrite);
      B.startBlock(lskip);
      B.line(`call void @scr_union_release(ptr ${u})`);
      B.br(ln);
      B.startBlock(lwrite);
    }
    const s = B.tmp();
    B.line(`${s} = call ptr @${toStr}(ptr ${u})`);
    this.putScrStr(B, buf, s);
    B.line(`call void @scr_str_release(ptr ${s})`);
    B.line(`call void @scr_union_release(ptr ${u})`);
    B.br(ln);
    B.startBlock(ln);
    const i2 = B.tmp();
    B.line(`${i2} = fadd double ${i}, ${f64Lit(1)}`);
    B.line(`store double ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
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
