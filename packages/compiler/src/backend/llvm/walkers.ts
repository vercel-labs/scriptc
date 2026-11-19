import { emitPerKeyOrder } from "./key-orders.js";
import { recordViewFieldPtr } from "./record-views.js";
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
import { isPerfEntryShape } from "../../ir/ir.js";
import {
  isPerfNodeTimingShape,
  isRefCounted,
  PERF_ENTRY_JSON_FIELDS,
  PERF_NODE_TIMING_JSON_FIELDS,
  typeKey,
} from "../../ir/ir.js";
import { jsonObjectKeyLabel } from "../json-literal.js";
import { llvmBytes, wtf8Bytes } from "../literals.js";
import { mangleFunction, mangleRecordStruct } from "../mangle.js";
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
  /** `@`-ref of the optional checked-dynamic field slot's ABSENT marker
   * (an immortal ScrDyn, address-compared). */
  dynAbsentRef(): string;
  /** The own enumerable properties JSON.stringify writes for an instance of
   * the class, in layout order (class-json.ts classJsonFields). */
  jsonClassFields(className: string): readonly { name: string; type: IrType }[];
  /** Reads one of those fields from the instance `obj`: the value its
   * writer takes, and the call that frees a temporary the read owns (or
   * null when it borrows the slot). */
  jsonClassFieldRead(
    B: BlockBuilder,
    obj: string,
    className: string,
    field: { name: string; type: IrType },
  ): { value: string; release: string | null };
  /** Whether the class's layout describes its instances exactly (its
   * jsonLayout flag and the class graph agree). */
  jsonClassReadsLayout(className: string): boolean;
  /** Writes the instance with the runtime walk, from its live capsule. */
  jsonClassDynWrite(B: BlockBuilder, buf: string, obj: string, className: string): void;
  /** `@`-ref of the checked-dynamic converter for `t`: returns an owned
   * (+1) box of the value. */
  toDynHelper(t: IrType): string;
  /** An owned (+1) checked-dynamic value for `t` that keeps its identity:
   * records and arrays come back as live references, so a hook can read
   * the value it was installed on as `this`. */
  streamTypedRefBoxValue(B: BlockBuilder, t: IrType, value: string): string;
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

  /** Whether the writer for `t` takes the nesting depth of the value it
   * serializes. Every container takes it so a value graph deeper than the
   * runtime walk's limit raises Node's catchable RangeError instead of
   * exhausting the native stack; a union forwards it to the arm that
   * matches. Leaves cannot recurse, so they take no depth. */
  jsonWriteTakesDepth(t: IrType): boolean {
    return t.kind === "record" || t.kind === "object" || t.kind === "array" || t.kind === "union";
  }

  /** The `, size depth` argument of a call to `t`'s writer, or nothing when
   * the writer takes no depth (a leaf). The root site passes 0; a container
   * writer passes the level of its members. */
  jsonWriteDepthArg(t: IrType, depth: string | null): string {
    return this.jsonWriteTakesDepth(t) ? `, ${this.S} ${depth ?? "0"}` : "";
  }

  jsonWriteHelper(t: IrType): string {
    const key = typeKey(t);
    const existing = this.jsonWriters.get(key);
    if (existing) return existing;
    const name = `sc_jw_${this.jsonWriters.size}`;
    this.jsonWriters.set(key, name);
    this.host.journalAllocated?.(name, "walkers.jsonWriteHelper", [t]);
    const B = new BlockBuilder();
    const takesDepth = this.jsonWriteTakesDepth(t);
    // The runtime's own walk (scr_json_callback_depth) bounds nesting at
    // SCR_JSON_MAX_DEPTH = 1000, throwing Node's catchable RangeError. The
    // emitted writers must do the same: a long chain of distinct instances
    // (or an acyclic-but-deep value graph the collector analysis cannot
    // call a cycle) otherwise recurses until the native stack ends the
    // process. `%d` is the value's level, so a chain of 1001 containers
    // (levels 0..1000) develops before the check trips, exactly the depth
    // the runtime walk allows.
    if (takesDepth) {
      const over = B.newLabel("jw.deep");
      const ok = B.newLabel("jw.ok");
      const too = B.tmp();
      B.line(`${too} = icmp ugt ${this.S} %d, 1000`);
      B.condBr(too, over, ok);
      B.startBlock(over);
      this.host.declare(`declare void @scr_stack_overflow()`);
      B.line(`call void @scr_stack_overflow() ; Maximum call stack size exceeded`);
      B.terminate("ret void");
      B.startBlock(ok);
    }
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
        this.emitRecordWriter(B, t.shapeId, "%d");
        break;
      case "object":
        this.emitClassWriter(B, t.className, "%d");
        break;
      case "array":
        this.emitArrayWriter(B, t.elem, traceAdapter(this.host, t) !== null, "%d");
        break;
      case "union":
        // A union is not itself a JSON container: its arm carries the
        // value at the union's own level.
        this.emitUnionWriter(B, t.unionId, "%d");
        break;
      case "map":
      case "set":
        // A Map or a Set held by a record, an array or a tuple has no own
        // enumerable property and no toJSON: the empty object, whatever it
        // holds (isJsonSafeAt admits it in those positions only).
        this.puts(B, "%b", "{}");
        break;
      default:
        throw new LlvmUnsupportedError(
          `jsonStringify:${t.kind}`,
          undefined,
          `JSON.stringify reaching a value of type ${typeKey(t)}`,
        );
    }
    B.terminate("ret void");
    this.defs.push(
      `define internal void @${name}(ptr %b, ${this.valTy(t)} %v${takesDepth ? `, ${this.S} %d` : ""}) ${FN_ATTRS} { ; stringify ${key}`,
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
    const base = this.host.nullableUnions.fieldBase(shapeId);
    let p: string;
    if (this.host.recordViews?.targets.has(shapeId) === true) {
      p = recordViewFieldPtr(
        B,
        this.S,
        mangleRecordStruct(shapeId),
        recName,
        index,
        index - base,
        (decl) => this.host.declare(decl),
        this.host.rcMode === undefined,
        (text) => this.host.cstr(text),
        this.host.recordViews?.partialTargets.has(shapeId) === true,
        this.host.recordViews?.marked.has(shapeId) === true,
      );
    } else {
      p = B.tmp();
      B.line(
        `${p} = getelementptr inbounds %${mangleRecordStruct(shapeId)}, ptr ${recName}, i64 0, i32 ${index}`,
      );
    }
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

  private emitRecordWriter(B: BlockBuilder, shapeId: string, depth: string): void {
    const shape = this.host.recordsById.get(shapeId);
    if (!shape)
      throw new InternalCompilerError(
        `llvm emitter bug: jsonStringify of unknown shape ${shapeId}`,
      );
    const fieldBase = this.host.nullableUnions.fieldBase(shapeId);
    const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + fieldBase]));
    const member = B.tmp();
    B.line(`${member} = add nuw ${this.S} ${depth}, 1`);
    this.emitLinkedRecordWriter(B, shapeId, depth);
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
        // A tuple slot keeps the array rule for a value the runtime walk
        // handles: its toJSON runs with the index as the key and an
        // undefined result is written `null`.
        if (this.serializationMayCallUserCode(f.type))
          this.emitRuntimeElement(B, v, f.type, f64Lit(i), member);
        else this.writeField(B, v, f.type, `[${llvmCommentText(f.name)}]`, member);
      });
      this.putc(B, "%b", "93"); // ']'
      if (cyclic) this.jbLeave(B);
      return;
    }
    // Fields serialize in DECLARED order (JS insertion order), or in the
    // value's own order for a shape with orderVariants; internal
    // '%'-fields stay hidden — jsonWriteHelper's contract, ported comment
    // and all. performance.nodeTiming is the exception: stringify runs its
    // toJSON first, which answers the class's own field list (without
    // uvMetricsInfo), so that list is what serializes.
    const toJsonOrder = isPerfNodeTimingShape(shape)
      ? PERF_NODE_TIMING_JSON_FIELDS
      : isPerfEntryShape(shape)
        ? PERF_ENTRY_JSON_FIELDS
        : null;
    emitPerKeyOrder(B, shape, fieldBase, "%v", (declaredOrder) => {
      const order = toJsonOrder ?? declaredOrder;
      const inOrder = new Set(order);
      if (
        toJsonOrder === null &&
        shape.fields.some((f) => !inOrder.has(f.name) && !f.name.startsWith("%"))
      ) {
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
      const runtimeMember = (f: { type: IrType }): boolean =>
        this.serializationMayCallUserCode(f.type);
      const droppable =
        emitFields.some(
          (f) =>
            undefinedArmTag(f.type, this.host.unionsById) >= 0 ||
            (f.optional === true && f.type.kind === "dyn"),
        ) ||
        !!shape.indexValue ||
        // The runtime member walk owns the comma: it must not run between
        // statically written commas, or after one.
        emitFields.some(runtimeMember);
      this.putc(B, "%b", "123"); // '{'
      if (!droppable) {
        emitFields.forEach((f, i) => {
          this.puts(B, "%b", `${i > 0 ? "," : ""}${jsonObjectKeyLabel(f.name)}`);
          if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
          const v = this.loadField(B, "%v", shapeId, fieldIndex.get(f.name)!, f.type);
          this.writeField(B, v, f.type, `${llvmCommentText(f.name)}`, member);
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
          } else if (f.optional === true && f.type.kind === "dyn") {
            // An ABSENT optional checked-dynamic field is dropped, like
            // Node; a present undefined still serializes as null.
            const isa = B.tmp();
            B.line(`${isa} = icmp eq ptr ${v}, ${this.host.dynAbsentRef()}`);
            const lw = B.newLabel("jwf.w");
            skip = B.newLabel("jwf.s");
            B.condBr(isa, skip, lw);
            B.startBlock(lw);
          }
          if (runtimeMember(f)) {
            // The value may be written by the runtime walk (a class that
            // gained a property bag, a checked-dynamic value, a foreign
            // element). It owns the comma and the key so an omitted member
            // leaves the buffer untouched.
            this.emitRuntimeMember(B, v, f.type, f.name, first, "%v", member);
          } else {
            comma();
            this.puts(B, "%b", jsonObjectKeyLabel(f.name));
            if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
            this.writeField(B, v, f.type, `${llvmCommentText(f.name)}`, member);
          }
          if (skip !== null) {
            B.br(skip);
            B.startBlock(skip);
          }
        }
        if (shape.indexValue)
          this.emitOverflowEntries(B, shape, first, member, edgeable(shape.indexValue));
      }
    });
    this.putc(B, "%b", "125"); // '}'
    if (cyclic) this.jbLeave(B);
  }

  /** A class instance whose own properties the static layout describes
   * exactly serializes from its slots, in the order the runtime walk lists
   * them. The class graph decides: a class that gained a property bag or
   * field attributes after the frontend admitted it is written by the
   * runtime walk instead (jsonClassReadsLayout), and a member or element
   * whose own class did so is written by the runtime walk at its position
   * (emitRuntimeMember / emitRuntimeElement), so its hook runs with the
   * right key and an omitted member drops. */
  private emitClassWriter(B: BlockBuilder, className: string, depth: string): void {
    const host = this.host;
    if (!host.jsonClassReadsLayout(className)) {
      host.jsonClassDynWrite(B, "%b", "%v", className);
      return;
    }
    const member = B.tmp();
    B.line(`${member} = add nuw ${this.S} ${depth}, 1`);
    const t: Extract<IrType, { kind: "object" }> = { kind: "object", className };
    const fields = host.jsonClassFields(className);
    const cyclic = traceAdapter(host, t) !== null;
    const edgeable = (ft: IrType): boolean => cyclic && traceAdapter(host, ft) !== null;
    const runtimeMember = (f: { type: IrType }): boolean =>
      this.serializationMayCallUserCode(f.type);
    // CYCLE-CAPABLE instances bracket the walk exactly like records.
    if (cyclic) this.jbEnter(B, false);
    const droppable =
      fields.some((f) => undefinedArmTag(f.type, host.unionsById) >= 0) ||
      fields.some(runtimeMember);
    this.putc(B, "%b", "123"); // '{'
    if (!droppable) {
      fields.forEach((f, i) => {
        this.puts(B, "%b", `${i > 0 ? "," : ""}${jsonObjectKeyLabel(f.name)}`);
        if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
        this.writeClassField(B, className, f, member);
      });
    } else {
      const first = B.slot();
      B.entryAllocas.push(`${first} = alloca i1`);
      B.line(`store i1 true, ptr ${first}`);
      const comma = (): void => {
        const isf = B.tmp();
        const lc = B.newLabel("jcl.c");
        const lj = B.newLabel("jcl.j");
        B.line(`${isf} = load i1, ptr ${first}`);
        B.condBr(isf, lj, lc);
        B.startBlock(lc);
        this.putc(B, "%b", "44"); // ','
        B.br(lj);
        B.startBlock(lj);
        B.line(`store i1 false, ptr ${first}`);
      };
      for (const f of fields) {
        if (f.type.kind === "nullT") {
          // A field that is always null contributes `null`, never a drop.
          comma();
          this.puts(B, "%b", jsonObjectKeyLabel(f.name));
          this.puts(B, "%b", "null");
          continue;
        }
        const read = host.jsonClassFieldRead(B, "%v", className, f);
        const utag = undefinedArmTag(f.type, host.unionsById);
        let skip: string | null = null;
        if (utag >= 0 && f.type.kind === "union") {
          // Undefined-valued field: dropped, like Node.
          const tag = this.unionTag(B, read.value, f.type.unionId);
          const isu = B.tmp();
          B.line(`${isu} = icmp eq i32 ${tag}, ${utag}`);
          const lw = B.newLabel("jcl.w");
          skip = B.newLabel("jcl.s");
          B.condBr(isu, skip, lw);
          B.startBlock(lw);
        }
        if (runtimeMember(f)) {
          // The value's class took the runtime walk after the frontend
          // admitted it, or its serialization may call user code: the
          // runtime member walk runs its toJSON with this field's key and
          // drops an omitted member.
          this.emitRuntimeMember(B, read.value, f.type, f.name, first, "%v", member);
        } else {
          comma();
          this.puts(B, "%b", jsonObjectKeyLabel(f.name));
          if (edgeable(f.type)) this.jbEdgeProp(B, f.name);
          this.writeField(B, read.value, f.type, `${llvmCommentText(f.name)}`, member);
        }
        // Released once, at the join both arms reach: a present nullable
        // class reference's union box is owned by this read, and the
        // undefined arm owns the unit box it was given — releasing twice
        // frees the box before the writer reads it again.
        if (skip !== null) {
          B.br(skip);
          B.startBlock(skip);
        }
        if (read.release !== null) B.line(read.release);
      }
    }
    this.putc(B, "%b", "125"); // '}'
    if (cyclic) this.jbLeave(B);
  }

  /** Writes one class field: the read's value through its writer, and the
   * temporary the read owns released after the write. */
  private writeClassField(
    B: BlockBuilder,
    className: string,
    f: { name: string; type: IrType },
    depth: string,
  ): void {
    if (f.type.kind === "nullT") {
      this.puts(B, "%b", "null");
      return;
    }
    const read = this.host.jsonClassFieldRead(B, "%v", className, f);
    this.writeField(B, read.value, f.type, `${llvmCommentText(f.name)}`, depth);
    if (read.release !== null) B.line(read.release);
  }

  /** A record copy linked to its source (IrModule.recordLinks) serializes
   * as its composed record, a record of the source's type with the copy's
   * values for the fields both declare. */
  private emitLinkedRecordWriter(B: BlockBuilder, shapeId: string, depth: string): void {
    emitLinkedRecordBranches(this.host, B, shapeId, "%v", (sourceT, composed) => {
      // The composed record is the same value at the same nesting level.
      B.line(
        `call void @${this.jsonWriteHelper(sourceT)}(ptr %b, ptr ${composed}${this.jsonWriteDepthArg(sourceT, depth)})`,
      );
      return "ret void";
    });
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
    B.line(`${kept} = load i1, ptr ${this.host.recordSourcesGate ?? RECORD_SOURCES_GATE}`);
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
      } else if (f.optional === true && f.type.kind === "dyn") {
        // An ABSENT optional checked-dynamic field contributes no key.
        const isAbsent = B.tmp();
        B.line(`${isAbsent} = icmp eq ptr ${v}, ${this.host.dynAbsentRef()}`);
        const lWrite = B.newLabel("jwf.write");
        B.condBr(isAbsent, lSkip, lWrite);
        B.startBlock(lWrite);
      }
      if (this.serializationMayCallUserCode(f.type)) {
        // The value may be written by the runtime walk, which owns the
        // comma, the key and the member's omission. This callback answers
        // whether it wrote anything, so the caller's first-member flag
        // travels through a slot.
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca i1`);
        B.line(`store i1 %first, ptr ${slot}`);
        this.emitRuntimeMember(B, v, f.type, fieldName, slot, "%v", "0");
        const left = B.tmp();
        const wrote = B.tmp();
        B.line(`${left} = load i1, ptr ${slot}`);
        B.line(`${wrote} = xor i1 ${left}, true`);
        B.terminate(`ret i1 ${wrote}`);
        return;
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
      this.writeField(B, v, f.type, `${llvmCommentText(fieldName)}`, "0");
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

  /** Whether the walker for `t` can leave an exception pending. Every
   * container writer checks its nesting depth and can raise the catchable
   * RangeError (scr_stack_overflow), and a checked-dynamic value runs
   * arbitrary user code (toJSON methods, getters, BigInts); the leaves
   * cannot throw. Cyclic values and kept checked sources throw from inside
   * a container writer, so they are covered by the first answer too. */
  jsonWriteMayThrow(t: IrType): boolean {
    if (this.jsonWriteTakesDepth(t)) return true;
    return t.kind === "dyn";
  }

  /** Overflow entries follow the declared fields, in JS OWN-KEY order
   * (scr_map_keys_js_order); keys escape like any JSON string;
   * undefined-valued entries drop (the optional-field rule). */
  private emitOverflowEntries(
    B: BlockBuilder,
    shape: IrRecordShape,
    first: string,
    depth: string,
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
      if (this.serializationMayCallUserCode(iv)) {
        // The entry's value may be written by the runtime walk: it owns the
        // comma, the key and the entry's omission, with the key as the
        // value's toJSON argument.
        this.emitRuntimeMemberKeyed(B, val, iv, k, first, "%v", depth);
      } else {
        // The comma dance over the shared `first` flag.
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
        host.declare(`declare void @scr_jb_put_json_str(ptr, ptr)`);
        B.line(`call void @scr_jb_put_json_str(ptr %b, ptr ${k})`);
        this.putc(B, "%b", "58"); // ':'
        if (edgeKeys) {
          this.host.declare(`declare void @scr_jb_edge_key(ptr, ptr)`);
          B.line(`call void @scr_jb_edge_key(ptr %b, ptr ${k})`);
        }
        B.line(
          `call void @${this.jsonWriteHelper(iv)}(ptr %b, ${this.valTy(iv)} ${val}${this.jsonWriteDepthArg(iv, depth)})`,
        );
      }
      B.line(`call void @scr_str_release(ptr ${k})`);
      if (isRefCounted(iv)) B.line(`call void ${releaseSym(host, iv)}(ptr ${val})`);
    });
    host.declare(`declare void @scr_arr_release(ptr)`);
    B.line(`call void @scr_arr_release(ptr ${ks})`);
  }

  /** Serializing a value of `t` can call user code that changes the
   * arrays or records holding it: it reaches an array that can hold
   * foreign elements (their toJSON and getters), a checked-dynamic value,
   * or a class instance its writer sends through the runtime walk. The
   * runtime walk runs `toJSON` and accessors, including ones installed on
   * an instance after the frontend admitted its class (a property bag) —
   * that is independent of whether the program holds foreign array
   * elements, so the answer cannot be gated on them. */
  private serializationMayCallUserCode(t: IrType, seen = new Set<string>()): boolean {
    const host = this.host;
    const key = typeKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    switch (t.kind) {
      case "dyn":
        return true;
      // A class instance calls user code when its class takes the runtime
      // walk, and a layout writer calls it when a field's serialization
      // does: the getter behind a runtime-written field can replace the
      // array or record that holds the instance, so the instance itself is
      // not callback-free.
      case "object":
        return (
          !host.jsonClassReadsLayout(t.className) ||
          host
            .jsonClassFields(t.className)
            .some((field) => this.serializationMayCallUserCode(field.type, seen))
        );
      case "array":
        return host.mayHoldForeign(t.elem) || this.serializationMayCallUserCode(t.elem, seen);
      case "record": {
        const shape = host.recordsById.get(t.shapeId);
        if (!shape) return false;
        // A shape realized as a view over a checked-dynamic object reads its
        // fields through the runtime, where accessors (installed on undeclared
        // keys or on the declared ones) can run user code and change the
        // containers of the walk.
        if (host.recordViews?.targets.has(t.shapeId) === true) return true;
        return (
          shape.fields.some((field) => this.serializationMayCallUserCode(field.type, seen)) ||
          (shape.indexValue !== undefined &&
            this.serializationMayCallUserCode(shape.indexValue, seen))
        );
      }
      case "union":
        return (host.unionsById.get(t.unionId)?.arms ?? []).some((arm) =>
          this.serializationMayCallUserCode(arm, seen),
        );
      default:
        return false;
    }
  }

  /** Whether serializing a value of `t` reaches a record element: a record,
   * an array of them (possibly nested), or a union with such an arm. A
   * checked-dynamic copy would flatten a record view into its empty slot
   * words, so an array that holds one is written by the type-directed
   * writer instead of being boxed. */
  private recordElements(t: IrType): boolean {
    switch (t.kind) {
      case "record":
        return true;
      case "array":
        return this.recordElements(t.elem);
      case "union":
        return (this.host.unionsById.get(t.unionId)?.arms ?? []).some((arm) =>
          this.recordElements(arm),
        );
      default:
        return false;
    }
  }

  /** Write a field value loaded borrowed from its record, at nesting level
   * `depth`. When its serialization can call user code that replaces the
   * field, the value is held across the write. */
  private writeField(B: BlockBuilder, v: string, t: IrType, comment: string, depth: string): void {
    const held = isRefCounted(t) && this.serializationMayCallUserCode(t);
    if (held) B.line(`call ptr ${retainSym(this.host, t)}(ptr ${v})`);
    const w = this.jsonWriteHelper(t);
    B.line(
      `call void @${w}(ptr %b, ${this.valTy(t)} ${v}${this.jsonWriteDepthArg(t, depth)}) ; ${comment}`,
    );
    if (held) B.line(`call void ${releaseSym(this.host, t)}(ptr ${v})`);
  }

  /** Writes one OBJECT member (`name`) whose value may be serialized by
   * the runtime walk: the comma, the key, the value's `toJSON` with that
   * key, and the written value, dropping the member when the hook answers
   * undefined. `first` is the writer's first-member flag slot (the runtime
   * owns the comma so an omitted member leaves no trace); `rec` is the
   * container the member belongs to, already on the circular-detection
   * stack when the writer pushed it. */
  private emitRuntimeMember(
    B: BlockBuilder,
    v: string,
    t: IrType,
    name: string,
    first: string,
    rec: string | null,
    depth: string,
  ): void {
    this.emitRuntimeMemberKeyed(B, v, t, this.host.internLiteral(name), first, rec, depth);
  }

  /** The overflow map of a record whose unknown index signature holds
   * checked-dynamic values — the one place a callable `toJSON` can be
   * installed on a record — or null when no such entry can exist. */
  private recordHookMap(B: BlockBuilder, v: string, shapeId: string): string | null {
    const shape = this.host.recordsById.get(shapeId);
    if (!shape || shape.indexValue === undefined || shape.indexValue.kind !== "dyn") return null;
    const at = B.tmp();
    const map = B.tmp();
    B.line(
      `${at} = getelementptr inbounds %${mangleRecordStruct(shape.id)}, ptr ${v}, i64 0, i32 ${shape.fields.length + this.host.nullableUnions.fieldBase(shape.id)}`,
    );
    B.line(`${map} = load ptr, ptr ${at} ; overflow map`);
    return map;
  }

  /** The member's comma and key, driven by the writer's first-member flag. */
  private emitMemberKey(B: BlockBuilder, keyRef: string, first: string): void {
    const isf = B.tmp();
    const comma = B.newLabel("jbm.c");
    const key = B.newLabel("jbm.k");
    B.line(`${isf} = load i1, ptr ${first}`);
    B.condBr(isf, key, comma);
    B.startBlock(comma);
    this.putc(B, "%b", "44"); // ','
    B.br(key);
    B.startBlock(key);
    B.line(`store i1 false, ptr ${first}`);
    this.host.declare(`declare void @scr_jb_put_json_str(ptr, ptr)`);
    B.line(`call void @scr_jb_put_json_str(ptr %b, ptr ${keyRef})`);
    this.putc(B, "%b", "58"); // ':'
  }

  /** Whether a union arm's own value can run a `toJSON` hook, so it must be
   * boxed as a checked-dynamic value. Records answer no: their only hook
   * lives in the unknown index signature, which the member and element
   * paths check directly. */
  private armNeedsBox(t: IrType, seen = new Set<string>()): boolean {
    const key = typeKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    switch (t.kind) {
      case "dyn":
        return true;
      case "object":
        return !this.host.jsonClassReadsLayout(t.className);
      case "union":
        return (this.host.unionsById.get(t.unionId)?.arms ?? []).some((arm) =>
          this.armNeedsBox(arm, seen),
        );
      default:
        return false;
    }
  }

  /** A union member: dispatch on the tag so a record arm's index-signature
   * hook runs with the member's key, an arm that can run its own hook is
   * boxed, and every other arm is written by the type-directed writer. */
  private emitUnionRuntimeMemberKeyed(
    B: BlockBuilder,
    v: string,
    t: IrType & { kind: "union" },
    keyRef: string,
    first: string,
    rec: string | null,
    depth: string,
  ): void {
    const host = this.host;
    const def = host.unionsById.get(t.unionId);
    if (!def)
      throw new InternalCompilerError(
        `llvm emitter bug: jsonStringify of unknown union ${t.unionId}`,
      );
    const tag = this.unionTag(B, v, t.unionId);
    const bad = B.newLabel("jbu.bad");
    const done = B.newLabel("jbu.d");
    const labels = def.arms.map(() => B.newLabel("jbu.a"));
    B.terminate(
      `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    def.arms.forEach((arm, i) => {
      B.startBlock(labels[i]!);
      const shape = arm.kind === "record" ? host.recordsById.get(arm.shapeId) : undefined;
      if (arm.kind === "record" && shape?.indexValue?.kind === "dyn") {
        const p = this.unionPeek(B, v, t.unionId);
        const map = this.recordHookMap(B, p, arm.shapeId);
        let plain: string | null = null;
        if (map !== null) {
          host.declare(
            `declare zeroext i1 @scr_jb_put_record_hook_member(ptr, ptr, ptr, ptr, ptr, ptr)`,
          );
          const receiver = host.streamTypedRefBoxValue(B, arm, p);
          const handled = B.tmp();
          B.line(
            `${handled} = call zeroext i1 @scr_jb_put_record_hook_member(ptr %b, ptr ${rec ?? "null"}, ptr ${map}, ptr ${keyRef}, ptr ${receiver}, ptr ${first})`,
          );
          host.declare(`declare void @scr_dyn_release(ptr)`);
          B.line(`call void @scr_dyn_release(ptr ${receiver})`);
          plain = B.newLabel("jbu.p");
          B.condBr(handled, done, plain);
          B.startBlock(plain);
        }
        this.emitMemberKey(B, keyRef, first);
        this.writeField(B, p, arm, "record member", depth);
      } else if (this.armNeedsBox(arm)) {
        const conv = host.toDynHelper(t);
        const box = B.tmp();
        B.line(`${box} = call ptr @${conv}(${this.valTy(t)} ${v}) ; +1`);
        host.declare(`declare void @scr_jb_put_dyn_member(ptr, ptr, ptr, ptr, ptr)`);
        B.line(
          `call void @scr_jb_put_dyn_member(ptr %b, ptr ${rec ?? "null"}, ptr ${keyRef}, ptr ${box}, ptr ${first})`,
        );
        host.declare(`declare void @scr_dyn_release(ptr)`);
        B.line(`call void @scr_dyn_release(ptr ${box})`);
      } else {
        this.emitMemberKey(B, keyRef, first);
        this.writeField(B, v, t, "union member", depth);
      }
      B.br(done);
    });
    B.startBlock(bad);
    host.needBadTag();
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
    B.startBlock(done);
  }

  /** emitUnionRuntimeMemberKeyed for an array slot: the hook's key is the
   * index, and an omitted answer is the slot's null. */
  private emitUnionRuntimeElement(
    B: BlockBuilder,
    v: string,
    t: IrType & { kind: "union" },
    index: string,
    depth: string,
  ): void {
    const host = this.host;
    const def = host.unionsById.get(t.unionId);
    if (!def)
      throw new InternalCompilerError(
        `llvm emitter bug: jsonStringify of unknown union ${t.unionId}`,
      );
    const tag = this.unionTag(B, v, t.unionId);
    const bad = B.newLabel("jue.bad");
    const done = B.newLabel("jue.d");
    const labels = def.arms.map(() => B.newLabel("jue.a"));
    B.terminate(
      `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    def.arms.forEach((arm, i) => {
      B.startBlock(labels[i]!);
      const shape = arm.kind === "record" ? host.recordsById.get(arm.shapeId) : undefined;
      if (arm.kind === "record" && shape?.indexValue?.kind === "dyn") {
        const p = this.unionPeek(B, v, t.unionId);
        const map = this.recordHookMap(B, p, arm.shapeId);
        let plain: string | null = null;
        if (map !== null) {
          host.declare(`declare zeroext i1 @scr_jb_put_record_hook_element(ptr, ptr, double, ptr)`);
          const receiver = host.streamTypedRefBoxValue(B, arm, p);
          const handled = B.tmp();
          B.line(
            `${handled} = call zeroext i1 @scr_jb_put_record_hook_element(ptr %b, ptr ${map}, double ${index}, ptr ${receiver})`,
          );
          host.declare(`declare void @scr_dyn_release(ptr)`);
          B.line(`call void @scr_dyn_release(ptr ${receiver})`);
          plain = B.newLabel("jue.p");
          B.condBr(handled, done, plain);
          B.startBlock(plain);
        }
        this.writeField(B, p, arm, "record element", depth);
      } else if (this.armNeedsBox(arm)) {
        const conv = host.toDynHelper(t);
        const box = B.tmp();
        B.line(`${box} = call ptr @${conv}(${this.valTy(t)} ${v}) ; +1`);
        host.declare(`declare void @scr_jb_put_dyn_element(ptr, ptr, double)`);
        B.line(`call void @scr_jb_put_dyn_element(ptr %b, ptr ${box}, double ${index})`);
        host.declare(`declare void @scr_dyn_release(ptr)`);
        B.line(`call void @scr_dyn_release(ptr ${box})`);
      } else {
        this.writeField(B, v, t, "union element", depth);
      }
      B.br(done);
    });
    B.startBlock(bad);
    host.needBadTag();
    B.line(`call void @sc_bad_tag()`);
    B.terminate(`unreachable`);
    B.startBlock(done);
  }

  /** emitRuntimeMember for a key that is only known at run time (an
   * `unknown`-indexed record's entry): `keyRef` is an LLVM value naming the
   * borrowed ScrStr key. */
  private emitRuntimeMemberKeyed(
    B: BlockBuilder,
    v: string,
    t: IrType,
    keyRef: string,
    first: string,
    rec: string | null,
    depth: string,
  ): void {
    const host = this.host;
    if (t.kind === "union") {
      this.emitUnionRuntimeMemberKeyed(B, v, t, keyRef, first, rec, depth);
      return;
    }
    // A record carries its hook in the unknown index signature, if it has
    // one: call it through the runtime (the hook answers for the whole
    // value), and otherwise write the record from the type-directed writer,
    // which keeps JSON's catchable circular-structure TypeError. Boxing the
    // record as a checked-dynamic value would deep-copy it, and a cycle in
    // that copy aborts the process.
    const map = t.kind === "record" ? this.recordHookMap(B, v, t.shapeId) : null;
    let done: string | null = null;
    if (map !== null) {
      host.declare(
        `declare zeroext i1 @scr_jb_put_record_hook_member(ptr, ptr, ptr, ptr, ptr, ptr)`,
      );
      const receiver = host.streamTypedRefBoxValue(B, t, v);
      const handled = B.tmp();
      B.line(
        `${handled} = call zeroext i1 @scr_jb_put_record_hook_member(ptr %b, ptr ${rec ?? "null"}, ptr ${map}, ptr ${keyRef}, ptr ${receiver}, ptr ${first})`,
      );
      host.declare(`declare void @scr_dyn_release(ptr)`);
      B.line(`call void @scr_dyn_release(ptr ${receiver})`);
      const plain = B.newLabel("jbm.plain");
      done = B.newLabel("jbm.done");
      B.condBr(handled, done, plain);
      B.startBlock(plain);
    }
    if (
      t.kind === "record" ||
      (t.kind === "array" && this.recordElements(t.elem)) ||
      map !== null
    ) {
      // An array of records is held and written by the type-directed writer:
      // boxing it deep-copies, and a record view element has no plain slots
      // to copy.
      this.emitMemberKey(B, keyRef, first);
      this.writeField(B, v, t, `${t.kind} member`, depth);
    } else {
      const conv = host.toDynHelper(t);
      const box = B.tmp();
      B.line(`${box} = call ptr @${conv}(${this.valTy(t)} ${v}) ; +1`);
      host.declare(`declare void @scr_jb_put_dyn_member(ptr, ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_jb_put_dyn_member(ptr %b, ptr ${rec ?? "null"}, ptr ${keyRef}, ptr ${box}, ptr ${first})`,
      );
      host.declare(`declare void @scr_dyn_release(ptr)`);
      B.line(`call void @scr_dyn_release(ptr ${box})`);
    }
    if (done !== null) {
      B.br(done);
      B.startBlock(done);
    }
  }

  /** Writes one ARRAY element at `index` whose value may be serialized by
   * the runtime walk: the value's `toJSON` with the index as its key and
   * the written value (`undefined` becomes `null`, an array slot's rule).
   * The caller writes the separator. */
  private emitRuntimeElement(
    B: BlockBuilder,
    v: string,
    t: IrType,
    index: string,
    depth: string,
  ): void {
    const host = this.host;
    if (t.kind === "union") {
      this.emitUnionRuntimeElement(B, v, t, index, depth);
      return;
    }
    const map = t.kind === "record" ? this.recordHookMap(B, v, t.shapeId) : null;
    let done: string | null = null;
    if (map !== null) {
      host.declare(`declare zeroext i1 @scr_jb_put_record_hook_element(ptr, ptr, double, ptr)`);
      const receiver = host.streamTypedRefBoxValue(B, t, v);
      const handled = B.tmp();
      B.line(
        `${handled} = call zeroext i1 @scr_jb_put_record_hook_element(ptr %b, ptr ${map}, double ${index}, ptr ${receiver})`,
      );
      host.declare(`declare void @scr_dyn_release(ptr)`);
      B.line(`call void @scr_dyn_release(ptr ${receiver})`);
      const plain = B.newLabel("jbe.plain");
      done = B.newLabel("jbe.done");
      B.condBr(handled, done, plain);
      B.startBlock(plain);
    }
    if (
      t.kind === "record" ||
      (t.kind === "array" && this.recordElements(t.elem)) ||
      map !== null
    ) {
      // The slot is borrowed and a callback inside the value may replace it;
      // writeField holds the value across its own traversal. An array of
      // records is written directly: boxing it would copy record views as
      // plain records.
      this.writeField(B, v, t, `${t.kind} element`, depth);
    } else {
      const conv = host.toDynHelper(t);
      const box = B.tmp();
      B.line(`${box} = call ptr @${conv}(${this.valTy(t)} ${v}) ; +1`);
      host.declare(`declare void @scr_jb_put_dyn_element(ptr, ptr, double)`);
      B.line(`call void @scr_jb_put_dyn_element(ptr %b, ptr ${box}, double ${index})`);
      host.declare(`declare void @scr_dyn_release(ptr)`);
      B.line(`call void @scr_dyn_release(ptr ${box})`);
    }
    if (done !== null) {
      B.br(done);
      B.startBlock(done);
    }
  }

  private emitArrayWriter(B: BlockBuilder, elem: IrType, cyclic: boolean, depth: string): void {
    const host = this.host;
    const w = this.jsonWriteHelper(elem);
    const member = B.tmp();
    B.line(`${member} = add nuw ${this.S} ${depth}, 1`);
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
      this.emitDenseArrayElements(B, elem, w, cyclic, finish, member);
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
        if (this.serializationMayCallUserCode(elem)) {
          // The element may be written by the runtime walk: it runs the
          // element's toJSON with the index as its key, and the array's
          // slot is re-read each iteration (the walk above already chose
          // the general path for it).
          this.emitRuntimeElement(B, v, elem, i, member);
        } else {
          B.line(`call void @${w}(ptr %b, ptr ${v}${this.jsonWriteDepthArg(elem, member)})`);
        }
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
    depth: string,
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
    B.line(
      `call void @${w}(ptr %b, ${this.valTy(elem)} ${v}${this.jsonWriteDepthArg(elem, depth)}) ; borrowed`,
    );
    const next = B.tmp();
    B.line(`${next} = add nuw ${S} ${i}, 1`);
    B.line(`store ${S} ${next}, ptr ${indexSlot}`);
    B.br(check);
    B.startBlock(general);
  }

  private emitUnionWriter(B: BlockBuilder, unionId: string, depth: string): void {
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
        B.line(
          `call void @${w}(ptr %b, ptr ${p}${this.jsonWriteDepthArg(arm, depth)}) ; ${arm.kind}`,
        );
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
            throw new LlvmUnsupportedError(
              `unionJoin:${arm.kind}`,
              undefined,
              `Array.prototype.join over a union with an arm of type ${typeKey(arm)}`,
            );
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

/** Branches for a record copy linked to its source (IrModule.recordLinks):
 * when the record `value` of shape `shapeId` links through one of the
 * module's pairs into that shape, `answer` emits the code for its composed
 * record (a +1 reference, released after `answer`) of the pair's source
 * type and names the terminator. Unlinked records fall through. */
export function emitLinkedRecordBranches(
  host: ShapeHost,
  B: BlockBuilder,
  shapeId: string,
  value: string,
  answer: (sourceT: IrType & { kind: "record" }, composed: string) => string,
): void {
  const links = (host.recordLinks ?? []).filter((link) => link.to === shapeId);
  if (links.length === 0) return;
  host.declare(`declare i32 @scr_record_link_pair(ptr)`);
  host.declare(`declare ptr @scr_record_link_source(ptr)`);
  const pair = B.tmp();
  B.line(`${pair} = call i32 @scr_record_link_pair(ptr ${value})`);
  for (const link of links) {
    const copyT: IrType = { kind: "record", shapeId };
    const sourceT: IrType & { kind: "record" } = { kind: "record", shapeId: link.from };
    const matches = B.tmp();
    const lLinked = B.newLabel("link.linked");
    const lNext = B.newLabel("link.unlinked");
    B.line(`${matches} = icmp eq i32 ${pair}, ${link.pair}`);
    B.condBr(matches, lLinked, lNext);
    B.startBlock(lLinked);
    const source = B.tmp(),
      copy = B.tmp(),
      owned = B.tmp(),
      composed = B.tmp();
    // The compose entry takes both references.
    B.line(`${source} = call ptr @scr_record_link_source(ptr ${value})`);
    B.line(`${owned} = call ptr ${retainSym(host, sourceT)}(ptr ${source})`);
    B.line(`${copy} = call ptr ${retainSym(host, copyT)}(ptr ${value})`);
    B.line(`${composed} = call ptr @${mangleFunction(link.compose)}(ptr ${copy}, ptr ${owned})`);
    const terminator = answer(sourceT, composed);
    B.line(`call void ${releaseSym(host, sourceT)}(ptr ${composed})`);
    B.terminate(terminator);
    B.startBlock(lNext);
  }
}
