import { emitPerKeyOrder } from "./key-orders.js";
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
import { llvmBytes, wtf8Bytes } from "../literals.js";
import { mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { llvmCommentText } from "./common.js";
import {
  llFieldType,
  loadStructField,
  releaseSym,
  retainSym,
  traceAdapter,
  type ShapeHost,
} from "./shapes.js";
import { disposeHookLoadLines, RECORD_SOURCES_GATE } from "./alloc.js";
import { recordMayKeepSource, recordSourceFieldOrder } from "./record-sources.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { emitUnionPeek, emitUnionTag } from "./union-repr.js";
import { undefinedArmTag } from "../../ir/analysis.js";

/** What the walkers need from the emitter beyond the shape tables: union
 * defs, the undefined-arm probe, interned ScrStr literals (unit-arm
 * ToString), and NUL-terminated C-string constants (scr_jb_puts /
 * scr_error-style label texts). */
export interface WalkerHost extends ShapeHost {
  readonly unionsById: Map<string, IrUnionDef>;
  /** Arrays of this element type can hold SCR_ARR_FOREIGN elements. */
  mayHoldForeign(elem: IrType): boolean;
  /** `@`-ref of an interned immortal ScrStr literal. */
  internLiteral(text: string): string;
  /** `@`-ref of an interned NUL-terminated byte-array constant. */
  cstr(text: string): string;
  /** Request the shared invalid-union-tag abort helper (@sc_bad_tag). */
  needBadTag(): void;
  /** i1: a value loaded from an undefined-armed record field slot is the
   * slot's ABSENT state. */
  fieldAbsentTestIn(B: BlockBuilder, value: string, unionId: string): string;
}

const FN_ATTRS = "#0";

export class LlWalkers {
  private readonly jsonWriters = new Map<string, string>();
  private readonly recordFieldWriters = new Map<string, string>();
  private readonly unionJoinFns = new Map<string, string>();
  /** Emitted function definitions, in interning order. */
  readonly defs: string[] = [];

  constructor(private readonly host: WalkerHost) {}

  /** Journal replay (emit-journal.ts): builds or finds the helper a chunk
   * emitter recorded, and answers its name. */
  replayHelper(op: string, args: readonly unknown[]): string {
    switch (op) {
      case "walkers.jsonWriteHelper":
        return this.jsonWriteHelper(args[0] as IrType);
      case "walkers.recordFieldWriter":
        return this.recordFieldWriter(args[0] as string);
      case "walkers.unionJoinHelper":
        return this.unionJoinHelper(args[0] as string);
      default:
        throw new InternalCompilerError(`llvm emitter bug: no walker replay ${op}`);
    }
  }

  private get S(): "i32" | "i64" {
    return this.host.sizeType;
  }

  /** The value-parameter LLVM type of a writer for `t`. */
  private valTy(t: IrType): string {
    return t.kind === "f64" ? "double" : t.kind === "bool" ? "i1" : "ptr";
  }

  /* ── the byte plumbing shared by every walker ─────────────────────────── */

  private putc(B: BlockBuilder, buf: string, byte: string): void {
    this.appendBytes(B, buf, String.fromCharCode(Number(byte)), () => {
      this.host.declare(`declare void @scr_jb_putc(ptr, i8)`);
      B.line(`call void @scr_jb_putc(ptr ${buf}, i8 ${byte})`);
    });
  }

  /** Fixed text and JSON tokens hold no lone surrogate, so they append
   * without the builder's surrogate-pair seam check. */
  private puts(B: BlockBuilder, buf: string, text: string): void {
    this.appendBytes(B, buf, text, () => {
      this.host.declare(`declare void @scr_jb_write_utf8(ptr, ptr, ${this.S})`);
      B.line(
        `call void @scr_jb_write_utf8(ptr ${buf}, ptr ${this.host.cstr(text)}, ${this.S} ${Buffer.byteLength(text, "utf8")}) ; ${JSON.stringify(text)}`,
      );
    });
  }

  /** Appends constant text: stored inline when it fits the buffer's spare
   * capacity, else through `grow`, the runtime append that reallocates.
   * ScrJsonBuf starts with { char *data; size_t len; size_t cap; }; an
   * unallocated buffer has cap 0 and always takes the runtime append. */
  private appendBytes(B: BlockBuilder, buf: string, text: string, grow: () => void): void {
    const bytes = wtf8Bytes(text);
    const S = this.S;
    const header = `{ ptr, ${S}, ${S} }`;
    const lenp = B.tmp(),
      len = B.tmp(),
      capp = B.tmp(),
      cap = B.tmp(),
      end = B.tmp(),
      fits = B.tmp();
    B.line(`${lenp} = getelementptr inbounds ${header}, ptr ${buf}, i32 0, i32 1`);
    B.line(`${len} = load ${S}, ptr ${lenp}`);
    B.line(`${capp} = getelementptr inbounds ${header}, ptr ${buf}, i32 0, i32 2`);
    B.line(`${cap} = load ${S}, ptr ${capp}`);
    B.line(`${end} = add nuw ${S} ${len}, ${bytes.length}`);
    B.line(`${fits} = icmp ule ${S} ${end}, ${cap}`);
    const inline = B.newLabel("jb.put"),
      slow = B.newLabel("jb.grow"),
      done = B.newLabel("jb.done");
    B.condBr(fits, inline, slow);
    B.startBlock(inline);
    const data = B.tmp(),
      at = B.tmp();
    B.line(`${data} = load ptr, ptr ${buf}`);
    B.line(`${at} = getelementptr inbounds i8, ptr ${data}, ${S} ${len}`);
    B.line(
      `store [${bytes.length} x i8] c"${llvmBytes(bytes, false)}", ptr ${at}, align 1 ; ${JSON.stringify(text)}`,
    );
    B.line(`store ${S} ${end}, ptr ${lenp}`);
    B.br(done);
    B.startBlock(slow);
    grow();
    B.br(done);
    B.startBlock(done);
  }

  /** Appends a borrowed string, including embedded NUL bytes, in one write. */
  private putScrStr(B: BlockBuilder, buf: string, s: string): void {
    this.host.declare(`declare void @scr_jb_put_str(ptr, ptr)`);
    B.line(`call void @scr_jb_put_str(ptr ${buf}, ptr ${s})`);
  }

  /** A union value's tag (representation-aware: union-repr.ts). */
  private unionTag(B: BlockBuilder, uName: string, unionId: string): string {
    return emitUnionTag(B, this.host.nullableUnions.get(unionId), uName);
  }

  private unionPeek(B: BlockBuilder, uName: string, unionId: string): string {
    return emitUnionPeek(B, this.host.nullableUnions.get(unionId), uName);
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
    this.host.journalAllocated?.(name, "walkers.jsonWriteHelper", [t]);
    const B = new BlockBuilder();
    switch (t.kind) {
      case "f64":
        this.host.declare(`declare void @scr_jb_put_f64(ptr, double)`);
        B.line(
          `call void @scr_jb_put_f64(ptr %b, double %v) ; NaN/Infinity -> null, -0 -> 0, like JS`,
        );
        break;
      case "bool": {
        const yes = B.newLabel("jwb.t"),
          no = B.newLabel("jwb.f"),
          done = B.newLabel("jwb.d");
        B.condBr("%v", yes, no);
        B.startBlock(yes);
        this.puts(B, "%b", "true");
        B.br(done);
        B.startBlock(no);
        this.puts(B, "%b", "false");
        B.br(done);
        B.startBlock(done);
        break;
      }
      case "string":
        this.host.declare(`declare void @scr_jb_put_json_str(ptr, ptr)`);
        B.line(`call void @scr_jb_put_json_str(ptr %b, ptr %v)`);
        break;
      case "date":
        this.host.declare(`declare void @scr_jb_put_date(ptr, ptr)`);
        B.line(`call void @scr_jb_put_date(ptr %b, ptr %v) ; toJSON(): ISO text, null if invalid`);
        break;
      case "dyn":
        // A checked-dynamic value serializes itself (runtime walker).
        // Bare stringify of dyn stays frontend-fenced, and overflow
        // entries under an `unknown` index signature go through
        // scr_jb_put_dyn_entry, which also runs the value's toJSON.
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
    this.host.journalBuilt?.();
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
    // An inline union field lends a private stack box (ABSENT kept).
    if (this.host.inlineUnions.record(t)) return loadStructField(B, this.S, p, t, true);
    const fieldTy = llFieldType(t, false);
    const raw = B.tmp();
    B.line(`${raw} = load ${fieldTy}, ptr ${p}`);
    if (t.kind === "union" && this.host.nullableUnions.has(t.unionId)) {
      if (undefinedArmTag(t, this.host.unionsById) < 0) return raw;
      // A nullable slot's ABSENT sentinel reads as undefined (NULL); the
      // boxed ABSENT state already carries the undefined tag.
      const absent = this.host.fieldAbsentTestIn(B, raw, t.unionId);
      const value = B.tmp();
      B.line(`${value} = select i1 ${absent}, ptr null, ptr ${raw}`);
      return value;
    }
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
    const fieldBase = this.host.nullableUnions.fieldBase(shapeId);
    const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + fieldBase]));
    if (recordMayKeepSource(shape)) this.emitRecordSourceWriter(B, shapeId);
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
        this.writeField(B, v, f.type, `[${llvmCommentText(f.name)}]`);
      });
      this.putc(B, "%b", "93"); // ']'
      if (cyclic) this.jbLeave(B);
      return;
    }
    // Fields serialize in DECLARED order (JS insertion order), or in the
    // value's own order for a shape with orderVariants; internal
    // '%'-fields stay hidden — jsonWriteHelper's contract, ported comment
    // and all.
    emitPerKeyOrder(B, shape, fieldBase, "%v", (order) => {
      const inOrder = new Set(order);
      if (shape.fields.some((f) => !inOrder.has(f.name) && !f.name.startsWith("%"))) {
        throw new InternalCompilerError(
          `llvm emitter bug: declaredOrder of shape ${shapeId} omits a non-internal field`,
        );
      }
      const byName = new Map(shape.fields.map((f) => [f.name, f]));
      // Function-valued properties are omitted, as JSON.stringify omits them.
      const emitFields = order
        .map((n) => byName.get(n))
        .filter((f) => f !== undefined)
        .filter((f) => f.type.kind !== "func");
      const droppable =
        emitFields.some((f) => undefinedArmTag(f.type, this.host.unionsById) >= 0) ||
        !!shape.indexValue;
      this.putc(B, "%b", "123"); // '{'
      if (!droppable) {
        emitFields.forEach((f, i) => {
          this.puts(B, "%b", `${i > 0 ? "," : ""}${jsonObjectKeyLabel(f.name)}`);
          if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
          const v = this.loadField(B, "%v", shapeId, fieldIndex.get(f.name)!, f.type);
          this.writeField(B, v, f.type, `${llvmCommentText(f.name)}`);
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
          if (utag >= 0 && f.type.kind === "union") {
            // Undefined-valued field: dropped, like Node.
            const tag = this.unionTag(B, v, f.type.unionId);
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
          this.writeField(B, v, f.type, `${llvmCommentText(f.name)}`);
          if (skip !== null) {
            B.br(skip);
            B.startBlock(skip);
          }
        }
        if (shape.indexValue) this.emitOverflowEntries(B, shape, first, edgeable(shape.indexValue));
      }
    });
    this.putc(B, "%b", "125"); // '}'
    if (cyclic) this.jbLeave(B);
  }

  /** A record that kept the undeclared properties of its checked source
   * (scr_record_source_note) serializes in the source's own-key order: the
   * runtime walks the kept keys, writing declared fields through the
   * shape's field writer and the others through the dyn writer, which may
   * throw (a BigInt added through an untyped reference) — the stringify
   * site checks pending. */
  private emitRecordSourceWriter(B: BlockBuilder, shapeId: string): void {
    const host = this.host;
    const writer = this.recordFieldWriter(shapeId);
    const lSource = B.newLabel("jw.source");
    const lNative = B.newLabel("jw.native");
    // Only a program that can keep record sources looks one up (the gate
    // folds to a constant), and only once one was kept: keeping a source
    // installs the dispose hook, so a NULL hook means the table is empty.
    const lHooked = B.newLabel("jw.hooked");
    const kept = B.tmp();
    B.line(`${kept} = load i1, ptr ${RECORD_SOURCES_GATE}`);
    B.condBr(kept, lHooked, lNative);
    B.startBlock(lHooked);
    const hook = B.tmp();
    const hookLines = disposeHookLoadLines(host, hook);
    if (hookLines !== null) {
      const lProbe = B.newLabel("jw.probe");
      for (const line of hookLines) B.line(line.trimStart());
      const installed = B.tmp();
      B.line(`${installed} = icmp ne ptr ${hook}, null`);
      B.condBr(installed, lProbe, lNative);
      B.startBlock(lProbe);
    }
    if (traceAdapter(host, { kind: "record", shapeId }) === null) {
      // One lookup: the runtime writes the record when it kept a source.
      host.declare(`declare zeroext i1 @scr_jb_try_record_source(ptr, ptr, ptr)`);
      const written = B.tmp();
      B.line(
        `${written} = call zeroext i1 @scr_jb_try_record_source(ptr %b, ptr %v, ptr @${writer})`,
      );
      B.condBr(written, lSource, lNative);
      B.startBlock(lSource);
      B.terminate("ret void");
      B.startBlock(lNative);
      return;
    }
    // Cycle-capable shapes bracket the kept-source walk with the circular
    // detection stack, like the native walk below.
    host.declare(`declare zeroext i1 @scr_record_source_has(ptr)`);
    const has = B.tmp();
    B.line(`${has} = call zeroext i1 @scr_record_source_has(ptr %v)`);
    B.condBr(has, lSource, lNative);
    B.startBlock(lSource);
    this.jbEnter(B, false);
    host.declare(`declare void @scr_jb_put_record_source(ptr, ptr, ptr)`);
    B.line(`call void @scr_jb_put_record_source(ptr %b, ptr %v, ptr @${writer})`);
    this.jbLeave(B);
    B.terminate("ret void");
    B.startBlock(lNative);
  }

  /** `sc_jwf_<n>(ptr b, ptr v, size index, i1 first) -> i1`: writes the
   * separator, key and value of the field at `index` in the shape's
   * declaration order (record-sources.ts) and answers true, or writes
   * nothing and answers false for an absent or undefined-valued optional
   * field and for internal '%'-fields. */
  private recordFieldWriter(shapeId: string): string {
    const existing = this.recordFieldWriters.get(shapeId);
    if (existing) return existing;
    const shape = this.host.recordsById.get(shapeId);
    if (!shape)
      throw new InternalCompilerError(`llvm emitter bug: field writer of unknown shape ${shapeId}`);
    const name = `sc_jwf_${this.recordFieldWriters.size}`;
    this.recordFieldWriters.set(shapeId, name);
    this.host.journalAllocated?.(name, "walkers.recordFieldWriter", [shapeId]);
    const fieldBase = this.host.nullableUnions.fieldBase(shapeId);
    const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + fieldBase]));
    const byName = new Map(shape.fields.map((f) => [f.name, f]));
    const cyclic = traceAdapter(this.host, { kind: "record", shapeId }) !== null;
    const order = recordSourceFieldOrder(shape);
    const B = new BlockBuilder();
    const lSkip = B.newLabel("jwf.skip");
    const labels = order.map(() => B.newLabel("jwf.field"));
    B.terminate(
      `switch ${this.S} %i, label %${lSkip} [${order.map((_, i) => ` ${this.S} ${i}, label %${labels[i]}`).join("")} ]`,
    );
    order.forEach((fieldName, i) => {
      B.startBlock(labels[i]!);
      const f = byName.get(fieldName)!;
      // Internal fields stay hidden; function-valued properties are omitted.
      if (fieldName.startsWith("%") || f.type.kind === "func") {
        B.terminate("ret i1 false");
        return;
      }
      const v = this.loadField(B, "%v", shapeId, fieldIndex.get(fieldName)!, f.type);
      const utag = undefinedArmTag(f.type, this.host.unionsById);
      if (utag >= 0 && f.type.kind === "union") {
        const tag = this.unionTag(B, v, f.type.unionId);
        const isUndefined = B.tmp();
        B.line(`${isUndefined} = icmp eq i32 ${tag}, ${utag}`);
        const lWrite = B.newLabel("jwf.write");
        B.condBr(isUndefined, lSkip, lWrite);
        B.startBlock(lWrite);
      }
      const lComma = B.newLabel("jwf.comma");
      const lKey = B.newLabel("jwf.key");
      B.condBr("%first", lKey, lComma);
      B.startBlock(lComma);
      this.putc(B, "%b", "44"); // ','
      B.br(lKey);
      B.startBlock(lKey);
      this.puts(B, "%b", jsonObjectKeyLabel(fieldName));
      if (cyclic && traceAdapter(this.host, f.type) !== null) this.jbEdgeProp(B, fieldName);
      this.writeField(B, v, f.type, `${llvmCommentText(fieldName)}`);
      B.terminate("ret i1 true");
    });
    B.startBlock(lSkip);
    B.terminate("ret i1 false");
    this.defs.push(
      `define internal zeroext i1 @${name}(ptr %b, ptr %v, ${this.S} %i, i1 zeroext %first) ${FN_ATTRS} { ; kept-source fields of ${shapeId}`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /** Whether the walker for `t` can leave an exception pending: cyclic
   * values, records serialized through a kept checked source, and
   * checked-dynamic values (toJSON methods, getters, BigInts), including
   * the foreign elements of arrays that can hold them. */
  jsonWriteMayThrow(t: IrType, seen = new Set<string>()): boolean {
    if (traceAdapter(this.host, t) !== null) return true;
    switch (t.kind) {
      case "dyn":
        return true;
      case "array":
        return this.host.mayHoldForeign(t.elem) || this.jsonWriteMayThrow(t.elem, seen);
      case "union":
        return (this.host.unionsById.get(t.unionId)?.arms ?? []).some((arm) =>
          this.jsonWriteMayThrow(arm, seen),
        );
      case "record": {
        if (seen.has(t.shapeId)) return false;
        seen.add(t.shapeId);
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape) return false;
        if (recordMayKeepSource(shape)) return true;
        return (
          shape.fields.some((f) => this.jsonWriteMayThrow(f.type, seen)) ||
          (shape.indexValue !== undefined && this.jsonWriteMayThrow(shape.indexValue, seen))
        );
      }
      default:
        return false;
    }
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
      `${ovfp} = getelementptr inbounds %${mangleRecordStruct(shape.id)}, ptr %v, i64 0, i32 ${shape.fields.length + this.host.nullableUnions.fieldBase(shape.id)}`,
    );
    B.line(`${ovf} = load ptr, ptr ${ovfp} ; overflow map`);
    if (iv.kind === "dyn") {
      // The runtime writes every entry with JSON.stringify's member rules:
      // each value's toJSON runs with its key before the entry is dropped
      // or written, and containers below it join the circular-structure
      // stack. It may leave an exception pending.
      host.declare(`declare void @scr_jb_put_dyn_entries(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_jb_put_dyn_entries(ptr %b, ptr %v, ptr ${ovf}, ptr ${first})`);
      return;
    }
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
      // union holding its undefined arm.
      let skipUndef: string | null = null;
      if (iv.kind === "union" && undefinedArmTag(iv, this.host.unionsById) >= 0) {
        const tag = this.unionTag(B, val, iv.unionId);
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

  /** Serializing a value of `t` can call user code that changes the
   * arrays or records holding it: it reaches an array that can hold
   * foreign elements (their toJSON and getters), or a value whose own
   * serialization may (a class instance, a checked-dynamic value), in a
   * program that has foreign elements at all. */
  private serializationMayCallUserCode(t: IrType, seen = new Set<string>()): boolean {
    const host = this.host;
    if (!host.mayHoldForeign({ kind: "f64" }) && !host.mayHoldForeign({ kind: "string" }))
      return false;
    const key = typeKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    switch (t.kind) {
      case "dyn":
      case "object":
        return true;
      case "array":
        return host.mayHoldForeign(t.elem) || this.serializationMayCallUserCode(t.elem, seen);
      case "record":
        return (host.recordsById.get(t.shapeId)?.fields ?? []).some((field) =>
          this.serializationMayCallUserCode(field.type, seen),
        );
      case "union":
        return (host.unionsById.get(t.unionId)?.arms ?? []).some((arm) =>
          this.serializationMayCallUserCode(arm, seen),
        );
      default:
        return false;
    }
  }

  /** Write a field value loaded borrowed from its record. When its
   * serialization can call user code that replaces the field, the value
   * is held across the write. */
  private writeField(B: BlockBuilder, v: string, t: IrType, comment: string): void {
    const held = isRefCounted(t) && this.serializationMayCallUserCode(t);
    if (held) B.line(`call ptr ${retainSym(this.host, t)}(ptr ${v})`);
    B.line(`call void @${this.jsonWriteHelper(t)}(ptr %b, ${this.valTy(t)} ${v}) ; ${comment}`);
    if (held) B.line(`call void ${releaseSym(this.host, t)}(ptr ${v})`);
  }

  private emitArrayWriter(B: BlockBuilder, elem: IrType, cyclic: boolean): void {
    const host = this.host;
    const w = this.jsonWriteHelper(elem);
    host.declare(`declare double @scr_arr_len(ptr)`);
    // A cycle-capable array joins the circular-detection stack exactly
    // like a cycle-capable record.
    if (cyclic) this.jbEnter(B, true);
    this.putc(B, "%b", "91"); // '['
    const finish = B.newLabel("jwa.end");
    // The dense walk borrows the storage and each element. When an
    // element's serialization can call user code, which can grow or
    // shrink the array or replace the element, the general walk below
    // reads each index afresh and holds its element instead.
    if (elem.kind !== "bool" && !this.serializationMayCallUserCode(elem))
      this.emitDenseArrayElements(B, elem, w, cyclic, finish);
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
      if (host.mayHoldForeign(elem)) {
        // A foreign element (SCR_ARR_FOREIGN) serializes its own value,
        // after its toJSON runs with the index as its key.
        const foreign = B.tmp();
        const foreignBlock = B.newLabel("jwa.foreign");
        const nullBlock = B.newLabel("jwa.null");
        B.line(`${foreign} = fcmp oeq double ${state}, ${f64Lit(3)}`);
        B.condBr(foreign, foreignBlock, nullBlock);
        B.startBlock(foreignBlock);
        host.declare(`declare ptr @scr_arr_get_foreign(ptr, double)`);
        host.declare(`declare void @scr_dyn_release(ptr)`);
        const payload = B.tmp();
        B.line(`${payload} = call ptr @scr_arr_get_foreign(ptr %v, double ${i}) ; +1`);
        host.declare(`declare void @scr_jb_put_dyn_element(ptr, ptr, double)`);
        B.line(`call void @scr_jb_put_dyn_element(ptr %b, ptr ${payload}, double ${i})`);
        B.line(`call void @scr_dyn_release(ptr ${payload})`);
        B.br(doneBlock);
        B.startBlock(nullBlock);
      }
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
    B.br(finish);
    B.startBlock(finish);
    this.putc(B, "%b", "93"); // ']'
    if (cyclic) this.jbLeave(B);
  }

  /** Writes the elements of an array whose indices below its length all
   * hold values in dense storage straight from its 8-byte slots, borrowing
   * each element (serialization runs no script code, so nothing can
   * change the array), then branches to `finish`. Other arrays continue
   * in the current block with the general element walk. */
  private emitDenseArrayElements(
    B: BlockBuilder,
    elem: IrType,
    w: string,
    cyclic: boolean,
    finish: string,
  ): void {
    const S = this.S;
    this.host.declare(`declare ptr @scr_arr_dense_slots(ptr, ptr)`);
    const lenSlot = B.slot(),
      indexSlot = B.slot();
    B.entryAllocas.push(`${lenSlot} = alloca ${S}`, `${indexSlot} = alloca ${S}`);
    const slots = B.tmp(),
      dense = B.tmp();
    B.line(`${slots} = call ptr @scr_arr_dense_slots(ptr %v, ptr ${lenSlot})`);
    B.line(`${dense} = icmp ne ptr ${slots}, null`);
    const start = B.newLabel("jwd.start"),
      general = B.newLabel("jwd.general"),
      check = B.newLabel("jwd.c"),
      body = B.newLabel("jwd.b");
    B.condBr(dense, start, general);
    B.startBlock(start);
    const len = B.tmp();
    B.line(`${len} = load ${S}, ptr ${lenSlot}`);
    B.line(`store ${S} 0, ptr ${indexSlot}`);
    B.br(check);
    B.startBlock(check);
    const i = B.tmp(),
      more = B.tmp();
    B.line(`${i} = load ${S}, ptr ${indexSlot}`);
    B.line(`${more} = icmp ult ${S} ${i}, ${len}`);
    B.condBr(more, body, finish);
    B.startBlock(body);
    const later = B.tmp(),
      comma = B.newLabel("jwd.cm"),
      value = B.newLabel("jwd.v");
    B.line(`${later} = icmp ne ${S} ${i}, 0`);
    B.condBr(later, comma, value);
    B.startBlock(comma);
    this.putc(B, "%b", "44"); // ','
    B.br(value);
    B.startBlock(value);
    if (cyclic) this.jbEdgeIdx(B, i);
    const at = B.tmp(),
      raw = B.tmp(),
      v = B.tmp();
    B.line(`${at} = getelementptr inbounds i64, ptr ${slots}, ${S} ${i}`);
    B.line(`${raw} = load i64, ptr ${at}`);
    if (elem.kind === "f64") B.line(`${v} = bitcast i64 ${raw} to double`);
    else B.line(`${v} = inttoptr i64 ${raw} to ptr`);
    B.line(`call void @${w}(ptr %b, ${this.valTy(elem)} ${v}) ; borrowed`);
    const next = B.tmp();
    B.line(`${next} = add nuw ${S} ${i}, 1`);
    B.line(`store ${S} ${next}, ptr ${indexSlot}`);
    B.br(check);
    B.startBlock(general);
  }

  private emitUnionWriter(B: BlockBuilder, unionId: string): void {
    const def = this.host.unionsById.get(unionId);
    if (!def)
      throw new InternalCompilerError(
        `llvm emitter bug: jsonStringify of unknown union ${unionId}`,
      );
    const tag = this.unionTag(B, "%v", unionId);
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
        const p = this.unionPeek(B, "%v", unionId);
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
    this.host.journalAllocated?.(name, "walkers.unionJoinHelper", [unionId]);

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
      if (host.mayHoldForeign({ kind: "union", unionId })) {
        // A foreign element (SCR_ARR_FOREIGN) joins as its ToString, like
        // every element but undefined and null.
        const notValue = B.newLabel("uj.f");
        const foreignLabel = B.newLabel("uj.foreign");
        B.condBr(isValue, lvalue, notValue);
        B.startBlock(notValue);
        const foreign = B.tmp();
        B.line(`${foreign} = fcmp oeq double ${state}, ${f64Lit(3)}`);
        B.condBr(foreign, foreignLabel, next);
        B.startBlock(foreignLabel);
        host.declare(`declare ptr @scr_arr_get_foreign(ptr, double)`);
        host.declare(`declare void @scr_dyn_release(ptr)`);
        const payload = B.tmp();
        B.line(`${payload} = call ptr @scr_arr_get_foreign(ptr %a, double ${i}) ; +1`);
        host.declare(`declare void @scr_jb_join_dyn(ptr, ptr)`);
        B.line(`call void @scr_jb_join_dyn(ptr ${buf}, ptr ${payload})`);
        B.line(`call void @scr_dyn_release(ptr ${payload})`);
        B.br(next);
      } else {
        B.condBr(isValue, lvalue, next);
      }
      B.startBlock(lvalue);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_arr_peek_ref(ptr %a, double ${i}) ; borrowed scalar union`);
      const tag = this.unionTag(B, u, unionId);
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
            this.putScrStr(B, buf, this.unionPeek(B, u, unionId));
            break;
          case "date": {
            host.declare(`declare ptr @scr_date_object_to_string(ptr)`);
            host.declare(`declare void @scr_str_release(ptr)`);
            const text = B.tmp();
            B.line(
              `${text} = call ptr @scr_date_object_to_string(ptr ${this.unionPeek(B, u, unionId)})`,
            );
            this.putScrStr(B, buf, text);
            B.line(`call void @scr_str_release(ptr ${text})`);
            break;
          }
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
    this.host.journalBuilt?.();
    return name;
  }
}
