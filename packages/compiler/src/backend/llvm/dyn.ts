import { emitPerKeyOrder } from "./key-orders.js";
import { typedRefConstructor } from "./shapes.js";
import { bindLiveArrayOps } from "./expr-stream-bridges.js";
import { BYTES_ELEM_NUM, SCR_ARR_FIELD, SCR_ARR_STATES, f64Lit, sizeToDouble } from "./common.js";
import { emitUnionPeek, emitUnionTag } from "./union-repr.js";
import {
  INLINE_UNION_FIELD,
  loadInlineUnion,
  stackUnionBox,
  storeInlineUnion,
  unionBoxBits,
} from "./inline-unions.js";
import { InternalCompilerError } from "../../errors.js";
/* ScrDyn helpers for the LLVM backend: per-type match predicates
 * (dynMatchHelper), checked builders (dynCheckHelper), static→dyn
 * converters (toDynHelper), the type-independent singletons (String
 * (unknown), caught→dyn, the keyed read, the destructuring
 * RequireObjectCoercible, GetIterator+N), and the checked-dynamic
 * function boundary's thunk/box/adapter triple. Helpers use the runtime ABI,
 * explicit reference ownership, and path-annotated failure messages.
 *
 * dyn layout facts this file compiles against (scr_runtime.h):
 *   ScrDyn   { size_t rc; ScrDynKind kind; bool buffer; union v; }
 *            v is naturally 8-byte aligned; size-bearing offsets below
 *            are selected from the target C ABI.
 *            v.num double | v.b i8 | v.str/v.bytes ptr at +16;
 *            v.arr { len +16, cap +24, items +32 };
 *            v.obj { len +16, cap +24, entries +32 };
 *            v.fn  { clo +16, thunk +24, sig +32, name +40, arity +48 }.
 *   ScrDynEntry { key, key_len, value, getter, setter, accessor, writable,
 *                 enumerable, configurable } — 48 bytes on 64-bit, 24 on 32-bit.
 *   ScrDynKind: NULL=0 BOOL=1 NUM=2 STR=3 ARR=4 OBJ=5 UNDEF=6 BYTES=7
 *               FUNC=8 HANDLE=9.
 *   ScrBytes { rc +0; len +8; elem +16; data +24 }.
 *   ScrDynPath { parent, key, index } — the %ScrDynPath type. */
import type { IrRecordShape, IrType, IrUnionDef } from "../../ir/ir.js";
import {
  accessorSlotProp,
  DYN_HANDLE_KINDS,
  isDirentShape,
  KEY_ORDER_FIELD,
  shapeKeyOrders,
  isDynTypedRefType,
  isRefCounted,
  isUnitType,
  recordTextCodecClass,
  textCodecRecordClass,
  typeKey,
} from "../../ir/ir.js";
import { dynDesc, streamTypedRefEligible } from "../../ir/analysis.js";
import { mangleRecordNew, mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { llvmCommentText } from "./common.js";
import {
  arrNewCall,
  elemAccess,
  llFieldType,
  mapFlagsOffset,
  releaseSym,
  traceAdapter,
  traceArg,
  vAdapters,
} from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { recordMayKeepSource, recordSourceFieldOrder } from "./record-sources.js";
import type { WalkerHost } from "./walkers.js";
import type { LlStreamTypedRefAdapter } from "./expr-context.js";

/** Whether to-dyn of a record shape keeps the record itself: an empty shape
 * and an event-listener record (a `handleEvent` function field) box their
 * identity. Every other shape, tuples included, copies its fields into a
 * fresh checked-dynamic value. */
export function recordDynKeepsIdentity(shape: IrRecordShape): boolean {
  if (shape.tuple) return false;
  return (
    (shape.fields.length === 0 && !shape.indexValue) ||
    shape.fields.some((f) => f.name === "handleEvent" && f.type.kind === "func")
  );
}

/** ScrDynKind values (scr_runtime.h). */
/** ScrDynHandleTag values (scr_dyn.h's explicit values; dyn-handle-tags.test.ts checks them). */
export const DYN_HANDLE_TAG_NUM: Record<string, number> = {
  httpReq: 0,
  httpRes: 1,
  netSocket: 2,
  netServer: 3,
  http2Session: 4,
  http2Stream: 5,
  httpClientReq: 6,
  child: 16,
  fileHandle: 17,
  dir: 44,
  dgramSocket: 62,
  cryptoHash: 52,
  cryptoHmac: 53,
};

/** The handle tags of TextEncoder and TextDecoder records boxed as dyn
 * (scr_dyn.h; scr_text_codec_dyn.c boxes and unboxes them). */
export const TEXT_CODEC_TAG_NUM: Record<"TextEncoder" | "TextDecoder", number> = {
  TextDecoder: 76,
  TextEncoder: 77,
};

/** The decoder record fields scr_text_decoder_to_dyn reads, in its
 * parameter order. */
const TEXT_DECODER_FIELDS = ["%TextDecoder", "%fatal", "%ignoreBOM", "%state"] as const;

/** Handle kinds whose runtime unit boxes them through its own function,
 * which installs the tag's ops on first use (scr_crypto.h). Programs that
 * never box one of these values do not link its dynamic members. */
const DYN_HANDLE_BOX_FN: Record<string, string> = {
  cryptoHash: "scr_crypto_hash_to_dyn",
  cryptoHmac: "scr_crypto_hash_to_dyn",
  dgramSocket: "scr_dgram_to_dyn",
};

/** Handle kinds whose box holds a unit-owned wrapper rather than the
 * handle itself (a dgram socket's box carries its untyped listeners):
 * the unit's own function unwraps it, with the tag check and TypeError
 * of scr_dyn_handle_unbox. */
const DYN_HANDLE_UNBOX_FN: Record<string, string> = {
  dgramSocket: "scr_dgram_from_dyn",
};

/** ScrMessageKind (scr_message.h): the node kinds message readers test. */
const MESSAGE_KIND = {
  UNDEFINED: 0,
  NULL: 1,
  BOOL: 2,
  NUMBER: 3,
  STRING: 4,
} as const;

export const DYN_KIND = {
  NULL: 0,
  BOOL: 1,
  NUM: 2,
  STR: 3,
  ARR: 4,
  OBJ: 5,
  UNDEF: 6,
  BYTES: 7,
  FUNC: 8,
  HANDLE: 9,
  PROMISE: 10,
  TYPED_REF: 12 /* SCR_DYN_TYPED_REF — static Web-stream transit capsule */,
  PROXY: 13,
  BIGINT: 14,
  SYMBOL: 15,
} as const;

/** What the dyn helpers need beyond the walker host: interned immortal
 * unit instances (undefined-armed dynCheck targets build them). */
export interface DynHost extends WalkerHost {
  unitInstanceRef(unionId: string, tag: number): string;
  /** See LlEmitter.retypeGuardRef. */
  retypeGuardRef(unionId: string): string;
  /** See ClassHost.virtualEntry. */
  virtualEntry?(implFn: string): string;
  /** See ClassHost.programLifetime. */
  readonly programLifetime?: ReadonlySet<string>;
  /** The immortal ABSENT field-slot state of an undefined-armed union. */
  absentInstanceRef(unionId: string): string;
  /** The shared adapter record: live array capsules read its `arrayOps`, so a
   * narrower return type would hand the native compiler a copy without it. */
  liveDynRefAdapter(t: IrType): LlStreamTypedRefAdapter;
  /** See moduleUsesDynBuiltinStream. */
  usesDynBuiltinStream?(): boolean;
  liveDynUnionRefAdapter(t: IrType & { kind: "union" }): string;
  /** The module has declaration-typed boundary casts (IrModule.declBoundary). */
  declBoundary?(): boolean;
  dynPromiseAdapter(t: IrType): string;
  isErrorClass(className: string): boolean;
  classSubtypes(className: string): readonly string[];
  /** emitter.ts's pendingTestLines: the inline pending-exception test. */
  pendingTestLines(dest: string): string[];
}

const FN_ATTRS = "#0";

/** scr_dyn_builtin_stream_check's kind for a runtime stream class (the
 * numbering of scr_dyn_builtin_class.c), or null. */
function builtinStreamKind(className: string): number | null {
  const kinds: Record<string, number> = {
    "%Readable": 2,
    "%Writable": 3,
    "%Duplex": 4,
    "%Transform": 5,
    "%PassThrough": 6,
  };
  return kinds[className] ?? null;
}

export class LlDyn {
  private readonly dynMatchers = new Map<string, string>();
  private readonly dynBuilders = new Map<string, string>();
  private readonly toDynFns = new Map<string, string>();
  private readonly dynFuncThunks = new Map<string, string>();
  private readonly dynFuncBoxes = new Map<string, string>();
  private readonly dynFuncAdapters = new Map<string, string>();
  private readonly messageListeners = new Map<string, string | null>();
  private readonly messageReaders = new Map<string, string>();
  private readonly promiseDynAdapters = new Map<string, string>();
  private readonly mapDynOps = new Map<string, string>();
  private dynToStrFn: string | null = null;
  private caughtToDynFn: string | null = null;
  private readonly helperMemo = new Map<string, string>();
  private readonly recursiveShapes = new Map<string, boolean>();
  private readonly holdsRecursiveShapes = new Map<string, boolean>();
  /** Emitted function definitions, in interning order. */
  readonly defs: string[] = [];

  constructor(private readonly host: DynHost) {}

  /** Journal replay (emit-journal.ts): builds or finds the helper a chunk
   * emitter recorded, and answers its name. */
  replayHelper(op: string, args: readonly unknown[]): string {
    switch (op) {
      case "dyn.collectionDynOps":
        return this.collectionDynOps(args[0] as IrType & { kind: "map" | "set" });
      case "dyn.dynMatchHelper":
        return this.dynMatchHelper(args[0] as IrType, args[1] as boolean);
      case "dyn.jsonSchema":
        return this.jsonSchema(args[0] as IrType);
      case "dyn.recordNameTable": {
        const shapeId = args[0] as string;
        return this.recordNameTable(shapeId, this.host.recordsById.get(shapeId)!).names;
      }
      case "dyn.jsonParseHelper":
        return this.jsonParseHelper(args[0] as IrType)!;
      case "dyn.dynCheckHelper":
        return this.dynCheckHelper(args[0] as IrType, args[1] as boolean);
      case "dyn.toDynHelper":
        return this.toDynHelper(args[0] as IrType);
      case "dyn.promiseDynAdapterHelper":
        return this.promiseDynAdapterHelper(args[0] as IrType);
      case "dyn.dynFuncThunkHelper":
        return this.dynFuncThunkHelper(args[0] as IrType & { kind: "func" });
      case "dyn.dynFuncBoxHelper":
        return this.dynFuncBoxHelper(args[0] as IrType & { kind: "func" });
      case "dyn.dynFuncAdapterHelper":
        return this.dynFuncAdapterHelper(args[0] as IrType & { kind: "func" });
      case "dyn.dynToStrHelper":
        return this.dynToStrHelper();
      case "dyn.dynIterNHelper":
        return this.dynIterNHelper();
      case "dyn.dynDestrCheckHelper":
        return this.dynDestrCheckHelper();
      case "dyn.dynKeyGetHelper":
        return this.dynKeyGetHelper();
      case "dyn.dynComputedKeyGetHelper":
        return this.dynComputedKeyGetHelper();
      case "dyn.caughtToDynHelper":
        return this.caughtToDynHelper();
      case "dyn.messageListenerHelper":
        return this.messageListenerHelper(args[0] as IrType & { kind: "func" }) ?? "";
      case "dyn.messageReaderHelper":
        return this.messageReaderHelper(args[0] as IrType);
      default:
        throw new InternalCompilerError(`llvm emitter bug: no dyn helper replay ${op}`);
    }
  }

  /** The types a dyn matcher or builder for `t` checks structurally: record
   * fields and index values, array elements and union arms. */
  private structuralChildren(t: IrType): readonly IrType[] {
    switch (t.kind) {
      case "record": {
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape) return [];
        const fields = shape.fields.map((f) => f.type);
        return shape.indexValue ? [...fields, shape.indexValue] : fields;
      }
      case "array":
        return [t.elem];
      case "union":
        return this.host.unionsById.get(t.unionId)?.arms ?? [];
      default:
        return [];
    }
  }

  /** A record or array type that reaches itself through its fields,
   * elements or union arms. Only these can describe a cyclic dyn value, so
   * only their matchers and builders track visited values. */
  private isRecursiveShape(t: IrType): boolean {
    if (t.kind !== "record" && t.kind !== "array") return false;
    const key = typeKey(t);
    const known = this.recursiveShapes.get(key);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    const pending = [...this.structuralChildren(t)];
    let recursive = false;
    while (pending.length > 0 && !recursive) {
      const next = pending.pop()!;
      const nextKey = typeKey(next);
      if (nextKey === key) recursive = true;
      else if (!seen.has(nextKey)) {
        seen.add(nextKey);
        pending.push(...this.structuralChildren(next));
      }
    }
    this.recursiveShapes.set(key, recursive);
    return recursive;
  }

  /** A type with a recursive shape among the types it reaches. Its matcher
   * and builder keep one visit session open for all of its members, so a
   * dyn value reached through two of them converts once. */
  private holdsRecursiveShape(t: IrType): boolean {
    const key = typeKey(t);
    const known = this.holdsRecursiveShapes.get(key);
    if (known !== undefined) return known;
    const seen = new Set<string>([key]);
    const pending = [...this.structuralChildren(t)];
    let holds = false;
    while (pending.length > 0 && !holds) {
      const next = pending.pop()!;
      const nextKey = typeKey(next);
      if (seen.has(nextKey)) continue;
      seen.add(nextKey);
      if (this.isRecursiveShape(next)) holds = true;
      else pending.push(...this.structuralChildren(next));
    }
    this.holdsRecursiveShapes.set(key, holds);
    return holds;
  }

  /** `name` around the structural body `${name}_body`, inside one visit
   * session of the runtime. A recursive shape's matcher ("match") answers
   * true for a (value, matcher) pair it is already checking further up the
   * stack. A recursive shape's builder ("build") answers the value it
   * already built for the same dyn value in the session, so cycles and
   * shared values keep their identity. Matchers ("visit") and builders
   * ("memo") of types holding recursive shapes only keep the session open
   * across their members. */
  private emitVisitWrapper(
    name: string,
    t: IrType,
    mode: "match" | "visit" | "build" | "memo",
  ): void {
    const host = this.host;
    const what = mode === "match" || mode === "build" ? "visits tracked" : "one visit session";
    if (mode === "match" || mode === "visit") {
      host.declare(`declare zeroext i1 @scr_dyn_match_visit(ptr, ptr, ptr)`);
      this.defs.push(
        `define internal zeroext i1 @${name}(ptr %d) ${FN_ATTRS} { ; matches ${llvmCommentText(typeKey(t))}, ${what}`,
        `entry:`,
        `  %ok = call zeroext i1 @scr_dyn_match_visit(ptr %d, ptr ${mode === "match" ? `@${name}` : "null"}, ptr @${name}_body)`,
        `  ret i1 %ok`,
        `}`,
        ``,
      );
      return;
    }
    const retain = mode === "build" ? vAdapters(host, t).retain : "null";
    host.declare(`declare ptr @scr_dyn_build_visit(ptr, ptr, ptr, ptr, ptr)`);
    this.defs.push(
      `define internal ptr @${name}(ptr %d, ptr %path) ${FN_ATTRS} { ; check ${llvmCommentText(typeKey(t))}, ${what}`,
      `entry:`,
      `  %r = call ptr @scr_dyn_build_visit(ptr %d, ptr %path, ptr ${mode === "build" ? `@${name}` : "null"}, ptr @${name}_body, ptr ${retain})`,
      `  ret ptr %r`,
      `}`,
      ``,
    );
  }

  /** The runtime call that gives a matcher or builder body a capsule's
   * dyn view: inside a visit session (`wrapped`), a capsule keeps the view
   * it was first given, so an outer visit can keep reading it. */
  private viewFn(wrapped: boolean): string {
    const fn = wrapped ? "scr_dyn_visit_view" : "scr_dyn_typed_ref_materialize";
    this.host.declare(`declare ptr @${fn}(ptr)`);
    return fn;
  }

  /** In a recursive shape's builder body: record `value`, just allocated
   * for %d, before its members are built. */
  private recordBuilt(B: BlockBuilder, name: string, value: string): void {
    this.host.declare(`declare void @scr_dyn_build_add(ptr, ptr, ptr)`);
    B.line(`call void @scr_dyn_build_add(ptr %d, ptr @${name}, ptr ${value})`);
  }

  /** The order a dyn value tries a union's arms in: the canonical order,
   * except that among the record arms, those with more required fields go
   * first, then those with more fields. Records are width-tolerant, so an
   * arm with fewer fields (`{}`, or one whose fields are all optional,
   * matches every object) would otherwise take an object that a wider arm
   * also matches and drop the fields only the wider arm has. */
  private unionArmOrder(def: IrUnionDef): number[] {
    const width = (i: number): [number, number] | null => {
      const arm = def.arms[i]!;
      if (arm.kind !== "record") return null;
      const shape = this.host.recordsById.get(arm.shapeId);
      if (!shape || shape.tuple) return null;
      const required = shape.fields.filter(
        (field) =>
          field.type.kind !== "union" ||
          !this.host.unionsById.get(field.type.unionId)?.arms.some((x) => x.kind === "undefinedT"),
      ).length;
      return [required, shape.fields.length];
    };
    const order = def.arms.map((_, i) => i);
    const records = order.filter((i) => width(i) !== null);
    const widest = [...records].sort((x, y) => {
      const [rx, fx] = width(x)!;
      const [ry, fy] = width(y)!;
      return ry - rx || fy - fx || x - y;
    });
    records.forEach((slot, k) => (order[slot] = widest[k]!));
    return order;
  }

  /** Branch to a variant only after its literal discriminator and complete
   * structure match. Use the same path for predicates and builders. */
  private unionArmMatch(
    B: BlockBuilder,
    def: IrUnionDef,
    tag: number,
    yes: string,
    no: string,
    preserveRefs = false,
  ): void {
    const guard = def.discriminant?.cases.find((candidate) => candidate.tag === tag);
    if (guard && def.discriminant) {
      const structure = B.newLabel("du.shape");
      const field = this.host.internLiteral(def.discriminant.field);
      guard.values.forEach((value, index) => {
        const suffix =
          typeof value === "string" ? "str" : typeof value === "boolean" ? "bool" : "num";
        const ty = typeof value === "string" ? "ptr" : typeof value === "boolean" ? "i1" : "double";
        const operand =
          typeof value === "string"
            ? this.host.internLiteral(value)
            : typeof value === "boolean"
              ? String(value)
              : f64Lit(value);
        this.host.declare(
          `declare zeroext i1 @scr_dyn_field_eq_${suffix}(ptr, ptr, ${ty}${ty === "i1" ? " zeroext" : ""})`,
        );
        const matches = B.tmp();
        B.line(
          `${matches} = call zeroext i1 @scr_dyn_field_eq_${suffix}(ptr %d, ptr ${field}, ${ty} ${operand})`,
        );
        const next = index === guard.values.length - 1 ? no : B.newLabel("du.literal");
        B.condBr(matches, structure, next);
        if (index !== guard.values.length - 1) B.startBlock(next);
      });
      B.startBlock(structure);
    }
    const matches = B.tmp();
    B.line(
      `${matches} = call zeroext i1 @${this.dynMatchHelper(def.arms[tag]!, preserveRefs)}(ptr %d)`,
    );
    B.condBr(matches, yes, no);
  }

  private get S(): "i32" | "i64" {
    return this.host.sizeType;
  }
  private abiOffset(native64: number, wasm32: number): number {
    return this.S === "i32" ? wasm32 : native64;
  }
  private get indexMaxDiv10(): string {
    return this.S === "i32" ? "429496728" : "1844674407370955160";
  }

  /** The value LLVM type of a dynCheck result / toDyn operand for `t`. */
  private valTy(t: IrType): string {
    return t.kind === "f64" || t.kind === "procStream"
      ? "double"
      : t.kind === "bool"
        ? "i1"
        : "ptr";
  }

  private collectionDynOps(t: IrType & { kind: "map" | "set" }): string {
    const key = typeKey(t);
    const prior = this.mapDynOps.get(key);
    if (prior) return prior;
    const name = `sc_map_dyn_${this.mapDynOps.size}`;
    this.mapDynOps.set(key, name);
    this.host.journalAllocated?.(name, "dyn.collectionDynOps", [t]);
    const keyType = t.kind === "map" ? t.key : t.elem;
    const valueType: IrType = t.kind === "map" ? t.value : { kind: "f64" };
    const emitSlot = (type: IrType, role: string): void => {
      const ty = this.valTy(type);
      const unpack =
        ty === "double"
          ? "bitcast i64 %slot to double"
          : ty === "i1"
            ? "trunc i64 %slot to i1"
            : "inttoptr i64 %slot to ptr";
      const pack =
        ty === "double"
          ? "bitcast double %value to i64"
          : ty === "i1"
            ? "zext i1 %value to i64"
            : "ptrtoint ptr %value to i64";
      // Collection reads expose the original mutable element, including
      // records/arrays inside unions, rather than a detached dyn snapshot.
      const B = new BlockBuilder();
      B.line(`%value = ${unpack}`);
      if (
        type.kind === "union" &&
        this.host.unionsById.get(type.unionId)?.arms.some(streamTypedRefEligible)
      ) {
        B.line(`%result = call ptr @${this.host.liveDynUnionRefAdapter(type)}(ptr %value)`);
      } else if (type.kind === "record" || type.kind === "array") {
        const adapter = this.host.liveDynRefAdapter(type);
        const rc = vAdapters(this.host, type);
        const typeId = typeKey(type);
        B.line(
          `%result = call ptr ${typedRefConstructor(this.host, type)}(ptr %value, ptr ${rc.retain}, ptr ${rc.release}, ptr ${this.host.cstr(typeId)}, ${this.S} ${Buffer.byteLength(typeId, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
        );
        for (const line of bindLiveArrayOps(this.host, adapter, "%result")) B.line(line);
      } else {
        B.line(`%result = call ptr @${this.toDynHelper(type)}(${ty} %value)`);
      }
      B.terminate("ret ptr %result");
      const unbox = this.dynCheckHelper(type);
      this.defs.push(
        `define internal ptr @${name}_${role}_box(i64 %slot) ${FN_ATTRS} {`,
        B.render(),
        `}`,
        "",
        `define internal i64 @${name}_${role}_unbox(ptr %d) ${FN_ATTRS} {`,
        `  %value = call ${ty === "i1" ? "zeroext i1" : ty} @${unbox}(ptr %d, ptr null)`,
        `  %result = ${pack}`,
        `  ret i64 %result`,
        `}`,
        "",
      );
    };
    emitSlot(keyType, "key");
    emitSlot(valueType, "value");
    this.defs.push(
      `@${name} = internal constant { ptr, ptr, ptr, ptr, ptr, ptr } { ptr ${this.host.cstr(key)}, ptr @${name}_key_box, ptr @${name}_key_unbox, ptr @${this.dynMatchHelper(keyType)}, ptr @${name}_value_box, ptr @${name}_value_unbox }`,
      "",
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── dyn node plumbing ─────────────────────────────────────────────── */

  /** Loads a dyn node's kind tag (after the size_t rc word). */
  private kindOf(B: BlockBuilder, d: string): string {
    const p = B.tmp();
    const k = B.tmp();
    B.line(`${p} = getelementptr inbounds i8, ptr ${d}, i64 ${this.abiOffset(8, 4)} ; ->kind`);
    B.line(`${k} = load i32, ptr ${p}`);
    return k;
  }

  /** Loads the 8-byte payload slot at +16 as the given LLVM type. */
  private payloadOf(B: BlockBuilder, d: string, ty: "double" | "ptr" | "i64"): string {
    const p = B.tmp();
    const v = B.tmp();
    B.line(`${p} = getelementptr inbounds i8, ptr ${d}, i64 16 ; ->v`);
    B.line(`${v} = load ${ty}, ptr ${p}`);
    return v;
  }

  /** Loads v.b (i8 at +16) as i1. */
  private boolOf(B: BlockBuilder, d: string): string {
    const p = B.tmp();
    const raw = B.tmp();
    const b = B.tmp();
    B.line(`${p} = getelementptr inbounds i8, ptr ${d}, i64 16 ; ->v.b`);
    B.line(`${raw} = load i8, ptr ${p}`);
    B.line(`${b} = trunc i8 ${raw} to i1`);
    return b;
  }

  /** Loads v.arr/v.obj length (size_t at +16). */
  private lenOf(B: BlockBuilder, d: string): string {
    const p = B.tmp();
    const n = B.tmp();
    B.line(`${p} = getelementptr inbounds i8, ptr ${d}, i64 16 ; ->v.arr.len`);
    B.line(`${n} = load ${this.S}, ptr ${p}`);
    return n;
  }

  /** Loads v.arr.items / v.obj.entries after two size_t fields. */
  private itemsOf(B: BlockBuilder, d: string): string {
    const p = B.tmp();
    const it = B.tmp();
    B.line(
      `${p} = getelementptr inbounds i8, ptr ${d}, i64 ${this.abiOffset(32, 24)} ; ->v.arr.items`,
    );
    B.line(`${it} = load ptr, ptr ${p}`);
    return it;
  }

  /** Loads items[i] (borrowed ScrDyn *). */
  private itemAt(B: BlockBuilder, items: string, i: string): string {
    const p = B.tmp();
    const e = B.tmp();
    B.line(`${p} = getelementptr inbounds ptr, ptr ${items}, ${this.S} ${i}`);
    B.line(`${e} = load ptr, ptr ${p}`);
    return e;
  }

  /** Object entry field addresses: entries + i*sizeof(ScrDynEntry), with
   * key, key_len, and value at offsets 0, 8, and 16 on 64-bit targets. */
  private entryAt(
    B: BlockBuilder,
    entries: string,
    i: string,
  ): { key: string; keyLen: string; value: string } {
    const off = B.tmp();
    const base = B.tmp();
    B.line(`${off} = mul ${this.S} ${i}, ${this.abiOffset(48, 24)} ; sizeof(ScrDynEntry)`);
    B.line(`${base} = getelementptr inbounds i8, ptr ${entries}, ${this.S} ${off}`);
    const key = B.tmp();
    B.line(`${key} = load ptr, ptr ${base}`);
    const klp = B.tmp();
    const keyLen = B.tmp();
    B.line(`${klp} = getelementptr inbounds i8, ptr ${base}, i64 ${this.abiOffset(8, 4)}`);
    B.line(`${keyLen} = load ${this.S}, ptr ${klp}`);
    const vp = B.tmp();
    const value = B.tmp();
    B.line(`${vp} = getelementptr inbounds i8, ptr ${base}, i64 ${this.abiOffset(16, 8)}`);
    B.line(`${value} = load ptr, ptr ${vp}`);
    return { key, keyLen, value };
  }

  /** An ScrStr's (len, data) pair — len via the %ScrStr header, data the
   * flexible tail at +24. */
  private strParts(B: BlockBuilder, s: string): { len: string; data: string } {
    const lp = B.tmp();
    const len = B.tmp();
    const data = B.tmp();
    B.line(`${lp} = getelementptr inbounds %ScrStr, ptr ${s}, i64 0, i32 1`);
    B.line(`${len} = load ${this.S}, ptr ${lp}`);
    B.line(`${data} = getelementptr inbounds i8, ptr ${s}, i64 ${this.abiOffset(24, 12)} ; ->data`);
    return { len, data };
  }

  /** `call ptr @scr_dyn_retain_v(x)` (+1; immortals skip). */
  private retainDyn(B: BlockBuilder, x: string): string {
    this.host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    const t = B.tmp();
    B.line(`${t} = call ptr @scr_dyn_retain_v(ptr ${x})`);
    return t;
  }

  /** THE immortal undefined dyn value (borrowed — retain to own). */
  private undef(B: BlockBuilder): string {
    this.host.declare(`declare ptr @scr_dyn_undefined()`);
    const t = B.tmp();
    B.line(`${t} = call ptr @scr_dyn_undefined()`);
    return t;
  }

  /** scr_dyn_obj_get with a compile-time key: borrowed member or null. */
  private objGetLit(B: BlockBuilder, d: string, key: string): string {
    this.host.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${this.S})`);
    const t = B.tmp();
    const len = Buffer.byteLength(key, "utf8");
    B.line(
      `${t} = call ptr @scr_dyn_obj_get(ptr ${d}, ptr ${this.host.cstr(key)}, ${this.S} ${len}) ; .${llvmCommentText(key)}`,
    );
    return t;
  }

  /** Branches past the caller's next emission when an undefined-armed
   * field value is the ABSENT state. Returns the label the caller must branch
   * to and start after its emission, or null when the type has no
   * undefined arm. */
  private skipIfAbsent(
    B: BlockBuilder,
    value: string,
    t: IrType & { kind: "union" },
  ): string | null {
    const def = this.host.unionsById.get(t.unionId);
    const utag = def ? def.arms.findIndex((arm) => arm.kind === "undefinedT") : -1;
    if (utag < 0) return null;
    const absent = this.host.fieldAbsentTestIn(B, value, t.unionId);
    const lSkip = B.newLabel("tdr.absent");
    const lSet = B.newLabel("tdr.set");
    B.condBr(absent, lSkip, lSet);
    B.startBlock(lSet);
    return lSkip;
  }

  /** A checked undefined-armed field value, or the field's ABSENT state
   * when the value is undefined because the source object has no own
   * property of that name (a missing JSON key stays missing; an explicit
   * undefined stays present). Proxy sources answer through their reads, so
   * they count as present. The checked value is a +1 union; replacing it
   * with the immortal absent instance releases nothing (unit instances are
   * immortal too). */
  private presenceOf(
    B: BlockBuilder,
    d: string,
    key: string,
    t: IrType & { kind: "union" },
    value: string,
  ): string {
    const def = this.host.unionsById.get(t.unionId);
    const utag = def ? def.arms.findIndex((arm) => arm.kind === "undefinedT") : -1;
    if (utag < 0) return value;
    const tag = emitUnionTag(B, this.host.nullableUnions.get(t.unionId), value);
    const isUndef = B.tmp();
    B.line(`${isUndef} = icmp eq i32 ${tag}, ${utag}`);
    const kind = this.kindOf(B, d);
    const isObj = B.tmp();
    B.line(`${isObj} = icmp eq i32 ${kind}, ${DYN_KIND.OBJ}`);
    const probe = B.tmp();
    B.line(`${probe} = and i1 ${isUndef}, ${isObj}`);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    B.line(`store ptr ${value}, ptr ${slot}`);
    const lProbe = B.newLabel("dcr.has");
    const lJoin = B.newLabel("dcr.hasj");
    B.condBr(probe, lProbe, lJoin);
    B.startBlock(lProbe);
    const own = this.objGetLit(B, d, key);
    const missing = B.tmp();
    const chosen = B.tmp();
    B.line(`${missing} = icmp eq ptr ${own}, null`);
    B.line(
      `${chosen} = select i1 ${missing}, ptr ${this.host.absentInstanceRef(t.unionId)}, ptr ${value}`,
    );
    B.line(`store ptr ${chosen}, ptr ${slot}`);
    B.br(lJoin);
    B.startBlock(lJoin);
    const out = B.tmp();
    B.line(`${out} = load ptr, ptr ${slot}`);
    return out;
  }

  /** Ordinary property lookup, including inherited data and accessors (+1). */
  private objReadLit(B: BlockBuilder, d: string, key: string, held = false): string {
    const read = held ? "scr_dyn_obj_read_held" : "scr_dyn_obj_read";
    this.host.declare(`declare ptr @${read}(ptr, ptr, ${this.S})`);
    const value = B.tmp();
    B.line(
      `${value} = call ptr @${read}(ptr ${d}, ptr ${this.host.cstr(key)}, ${this.S} ${Buffer.byteLength(key, "utf8")})`,
    );
    return value;
  }

  /** A member read for a matcher or builder of `t`: values that can reach a
   * recursive shape go through the runtime's held read, so its visit
   * tracking does not count the read's reference. Returns the value and
   * the matching release. */
  private memberRead(B: BlockBuilder, key: string, t: IrType): { value: string; release: string } {
    // An accessor slot reads the getter or setter of the accessor property
    // the checked-dynamic copy holds for it (see accessorSlotProp).
    const slot = accessorSlotProp(key);
    if (slot !== null) {
      this.host.declare(`declare ptr @scr_dyn_obj_accessor_fn(ptr, ptr, ${this.S}, i1 zeroext)`);
      this.host.declare(`declare void @scr_dyn_release(ptr)`);
      const fn = B.tmp();
      B.line(
        `${fn} = call ptr @scr_dyn_obj_accessor_fn(ptr %d, ptr ${this.host.cstr(slot.prop)}, ${this.S} ${Buffer.byteLength(slot.prop, "utf8")}, i1 ${slot.kind === "set" ? "true" : "false"})`,
      );
      return { value: fn, release: "scr_dyn_release" };
    }
    const held = this.isRecursiveShape(t) || this.holdsRecursiveShape(t);
    const release = held ? "scr_dyn_release_held" : "scr_dyn_release";
    this.host.declare(`declare void @${release}(ptr)`);
    return { value: this.objReadLit(B, "%d", key, held), release };
  }

  /** Appends a borrowed string, preserving its full byte length. */
  private putScrStr(B: BlockBuilder, buf: string, s: string): void {
    this.host.declare(`declare void @scr_jb_put_str(ptr, ptr)`);
    B.line(`call void @scr_jb_put_str(ptr ${buf}, ptr ${s})`);
  }

  /** Fixed text and JSON tokens hold no lone surrogate, so they append
   * without the builder's surrogate-pair seam check. */
  private puts(B: BlockBuilder, buf: string, text: string): void {
    this.host.declare(`declare void @scr_jb_write_utf8(ptr, ptr, ${this.S})`);
    B.line(
      `call void @scr_jb_write_utf8(ptr ${buf}, ptr ${this.host.cstr(text)}, ${this.S} ${Buffer.byteLength(text, "utf8")}) ; ${JSON.stringify(text)}`,
    );
  }

  /** A size_t counting loop: emits header/body, calls `body(i)`, closes.
   * The body must not terminate its final block. */
  private i64Loop(
    B: BlockBuilder,
    hint: string,
    limit: string,
    body: (i: string, brNext: () => void, next: string) => void,
  ): void {
    const iSlot = B.slot();
    B.entryAllocas.push(`${iSlot} = alloca ${this.S}`);
    B.line(`store ${this.S} 0, ptr ${iSlot}`);
    const lc = B.newLabel(`${hint}.c`);
    const lb = B.newLabel(`${hint}.b`);
    const ln = B.newLabel(`${hint}.n`);
    const le = B.newLabel(`${hint}.e`);
    B.br(lc);
    B.startBlock(lc);
    const i = B.tmp();
    const cont = B.tmp();
    B.line(`${i} = load ${this.S}, ptr ${iSlot}`);
    B.line(`${cont} = icmp ult ${this.S} ${i}, ${limit}`);
    B.condBr(cont, lb, le);
    B.startBlock(lb);
    body(i, () => B.br(ln), ln);
    B.br(ln);
    B.startBlock(ln);
    const i2 = B.tmp();
    B.line(`${i2} = add ${this.S} ${i}, 1`);
    B.line(`store ${this.S} ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
  }

  /** Emit the standard in-helper pending check: on a pending exception
   * run `cleanup` and return `dummy`. */
  /** The failure block of a union dynCheck whose value matched no arm. A
   * value of the one container kind exactly one arm can take (an object
   * for the union's only record arm, an array for its only array arm,
   * beside unit and scalar arms) runs that arm's builder, which throws the
   * deepest failing path and the reason there (`expected string at
   * $.order.owner.id, got undefined`) instead of the union's own outer
   * path. Other values, and an arm builder that unexpectedly succeeds,
   * fall through to the union's message. Only the failure path changes. */
  private unionArmFailure(B: BlockBuilder, def: IrUnionDef, kind: string): void {
    const scalar = (arm: IrType): boolean =>
      isUnitType(arm) ||
      arm.kind === "f64" ||
      arm.kind === "bool" ||
      arm.kind === "string" ||
      arm.kind === "bigint";
    const containers = def.arms.filter((arm) => !scalar(arm));
    const arm = containers.length === 1 ? containers[0]! : null;
    const container =
      arm?.kind === "array"
        ? DYN_KIND.ARR
        : arm?.kind === "record" && !this.host.recordsById.get(arm.shapeId)?.tuple
          ? DYN_KIND.OBJ
          : null;
    if (!arm || container === null) return;
    const host = this.host;
    const deep = B.newLabel("dcu.deep");
    const outer = B.newLabel("dcu.outer");
    const same = B.tmp();
    B.line(`${same} = icmp eq i32 ${kind}, ${container}`);
    B.condBr(same, deep, outer);
    B.startBlock(deep);
    const built = B.tmp();
    B.line(`${built} = call ptr @${this.dynCheckHelper(arm)}(ptr %d, ptr %path)`);
    this.pendingBail(B, "dcu.deep", () => {}, "ptr null");
    const rc = vAdapters(host, arm);
    B.line(`call void ${rc.release}(ptr ${built})`);
    B.br(outer);
    B.startBlock(outer);
  }

  private pendingBail(B: BlockBuilder, hint: string, cleanup: () => void, dummy: string): void {
    const p = B.tmp();
    for (const line of this.host.pendingTestLines(p)) B.line(line.trimStart());
    const lu = B.newLabel(`${hint}.u`);
    const lk = B.newLabel(`${hint}.k`);
    B.condBr(p, lu, lk);
    B.startBlock(lu);
    cleanup();
    B.terminate(`ret ${dummy}`);
    B.startBlock(lk);
  }

  /** A capsule boxed from this class by this program carries the class's
   * key constant itself: return its instance (+1) without comparing names
   * or calling the capsule's retain adapter. Other values continue. */
  private exactClassCapsule(B: BlockBuilder, t: IrType & { kind: "object" }): void {
    const key = typeKey(t);
    const present = B.tmp();
    const inspect = B.newLabel("dc.exact.inspect");
    const capsule = B.newLabel("dc.exact.capsule");
    const hit = B.newLabel("dc.exact.hit");
    const miss = B.newLabel("dc.exact.miss");
    B.line(`${present} = icmp ne ptr %d, null`);
    B.condBr(present, inspect, miss);
    B.startBlock(inspect);
    const typed = B.tmp();
    B.line(`${typed} = icmp eq i32 ${this.kindOf(B, "%d")}, ${DYN_KIND.TYPED_REF}`);
    B.condBr(typed, capsule, miss);
    B.startBlock(capsule);
    const keySlot = B.tmp(),
      keyPtr = B.tmp(),
      same = B.tmp();
    B.line(
      `${keySlot} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(40, 28)} ; ->v.typed_ref.type_key`,
    );
    B.line(`${keyPtr} = load ptr, ptr ${keySlot}`);
    B.line(`${same} = icmp eq ptr ${keyPtr}, ${this.host.cstr(key)}`);
    B.condBr(same, hit, miss);
    B.startBlock(hit);
    const object = this.payloadOf(B, "%d", "ptr");
    const retained = B.tmp();
    B.line(`${retained} = call ptr ${vAdapters(this.host, t).retain}(ptr ${object})`);
    B.terminate(`ret ptr ${retained}`);
    B.startBlock(miss);
  }

  /* ── dynMatchHelper (walkers.ts, ported) ──────────────────────── */

  /** Native subclass capsules also satisfy a checked base-class slot.
   * Class layouts share their base prefix, so unboxing retains the same
   * pointer and virtual dispatch still uses the object's original vtable. */
  private typedRefMatches(B: BlockBuilder, t: IrType): string {
    this.host.declare(`declare zeroext i1 @scr_dyn_typed_ref_is(ptr, ptr, ${this.S})`);
    const types: IrType[] = isDynTypedRefType(t)
      ? this.host.classSubtypes(t.className).map((className) => ({ kind: "object", className }))
      : [t];
    let matched = "false";
    for (const type of types) {
      const key = typeKey(type);
      const next = B.tmp();
      B.line(
        `${next} = call zeroext i1 @scr_dyn_typed_ref_is(ptr %d, ptr ${this.host.cstr(key)}, ${this.S} ${Buffer.byteLength(key, "utf8")})`,
      );
      if (matched === "false") matched = next;
      else {
        const either = B.tmp();
        B.line(`${either} = or i1 ${matched}, ${next}`);
        matched = either;
      }
    }
    return matched;
  }

  /** `sc_dm_<n>(ptr d) -> i1` — does this dyn fit T? Never throws. */
  dynMatchHelper(t: IrType, preserveRefs = false): string {
    const key = typeKey(t);
    const matcherKey = preserveRefs ? `identity:${key}` : key;
    const existing = this.dynMatchers.get(matcherKey);
    if (existing) return existing;
    const name = `sc_dm_${this.dynMatchers.size}`;
    this.dynMatchers.set(matcherKey, name);
    this.host.journalAllocated?.(name, "dyn.dynMatchHelper", [t, preserveRefs]);
    const codec = textCodecRecordClass(t, (id) => this.host.recordsById.get(id));
    if (codec !== null) {
      // A codec matches only its own handle box.
      const B = new BlockBuilder();
      const matched = this.handleTagMatches(B, TEXT_CODEC_TAG_NUM[codec]);
      B.terminate(`ret i1 ${matched}`);
      this.defs.push(
        `define internal zeroext i1 @${name}(ptr %d) ${FN_ATTRS} { ; matches ${key}`,
        B.render(),
        `}`,
        ``,
      );
      this.host.journalBuilt?.();
      return name;
    }
    const recursive = this.isRecursiveShape(t);
    const wrapped = recursive || this.holdsRecursiveShape(t);
    const B = new BlockBuilder();
    if (isRefCounted(t) && t.kind !== "dyn") {
      const matched = this.typedRefMatches(B, t);
      const lRef = B.newLabel("dm.tr");
      const lNext = B.newLabel("dm.nt");
      B.condBr(matched, lRef, lNext);
      B.startBlock(lRef);
      B.terminate(`ret i1 true`);
      B.startBlock(lNext);
    }
    // A union matches a capsule of another type through its arms below: a
    // class capsule in a `C | undefined` field matches the `C` arm.
    if (t.kind !== "dyn" && t.kind !== "union") {
      const view = this.viewFn(wrapped);
      this.host.declare(`declare void @scr_dyn_release_v(ptr)`);
      const kind = this.kindOf(B, "%d");
      const capsule = B.tmp();
      B.line(`${capsule} = icmp eq i32 ${kind}, ${DYN_KIND.TYPED_REF}`);
      const lCapsule = B.newLabel("dm.tr.mat");
      const lPlain = B.newLabel("dm.tr.plain");
      B.condBr(capsule, lCapsule, lPlain);
      B.startBlock(lCapsule);
      if (preserveRefs) {
        B.terminate(`ret i1 false`);
      } else {
        const materialized = B.tmp();
        const matched = B.tmp();
        B.line(`${materialized} = call ptr @${view}(ptr %d)`);
        B.line(`${matched} = call zeroext i1 @${name}(ptr ${materialized})`);
        B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
        B.terminate(`ret i1 ${matched}`);
      }
      B.startBlock(lPlain);
    }
    const kindIs = (k: number): void => {
      const kd = this.kindOf(B, "%d");
      const r = B.tmp();
      B.line(`${r} = icmp eq i32 ${kd}, ${k}`);
      B.terminate(`ret i1 ${r}`);
    };
    switch (t.kind) {
      case "date": {
        this.host.declare(`declare zeroext i1 @scr_dyn_native_date_is(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call zeroext i1 @scr_dyn_native_date_is(ptr %d)`);
        B.terminate(`ret i1 ${r}`);
        break;
      }
      case "url":
      case "searchParams": {
        const native = t.kind === "url" ? "url" : "search_params";
        this.host.declare(`declare zeroext i1 @scr_dyn_native_${native}_is(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call zeroext i1 @scr_dyn_native_${native}_is(ptr %d)`);
        B.terminate(`ret i1 ${r}`);
        break;
      }
      case "regex": {
        this.host.declare(`declare zeroext i1 @scr_dyn_native_regex_is(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call zeroext i1 @scr_dyn_native_regex_is(ptr %d)`);
        B.terminate(`ret i1 ${r}`);
        break;
      }
      case "map":
      case "set": {
        this.host.declare(`declare zeroext i1 @scr_dyn_native_collection_is(ptr, i32, ptr)`);
        const r = B.tmp();
        const typed =
          t.kind === "map" ? t.key.kind !== "dyn" || t.value.kind !== "dyn" : t.elem.kind !== "dyn";
        B.line(
          `${r} = call zeroext i1 @scr_dyn_native_collection_is(ptr %d, i32 ${t.kind === "map" ? 1 : 0}, ptr ${typed ? this.host.cstr(typeKey(t)) : "null"})`,
        );
        B.terminate(`ret i1 ${r}`);
        break;
      }
      case "bigint":
        kindIs(DYN_KIND.BIGINT);
        break;
      case "promise":
        kindIs(DYN_KIND.PROMISE);
        break;
      case "procStream": {
        this.host.declare(`declare zeroext i1 @scr_dyn_process_stdio_is(ptr)`);
        const matched = B.tmp();
        B.line(`${matched} = call zeroext i1 @scr_dyn_process_stdio_is(ptr %d)`);
        B.terminate(`ret i1 ${matched}`);
        break;
      }
      case "symbol":
        kindIs(DYN_KIND.SYMBOL);
        break;
      case "f64":
        kindIs(DYN_KIND.NUM);
        break;
      case "string":
        kindIs(DYN_KIND.STR);
        break;
      case "bool":
        kindIs(DYN_KIND.BOOL);
        break;
      case "nullT":
        kindIs(DYN_KIND.NULL);
        break;
      case "undefinedT":
        kindIs(DYN_KIND.UNDEF);
        break;
      case "dyn":
        // An `unknown` target: every dyn value fits, undefined included.
        B.terminate(`ret i1 true`);
        break;
      case "bytes": {
        this.host.declare(`declare zeroext i1 @scr_dyn_bytes_is(ptr, i32)`);
        const matched = B.tmp();
        B.line(
          `${matched} = call zeroext i1 @scr_dyn_bytes_is(ptr %d, i32 ${BYTES_ELEM_NUM[t.elem]})`,
        );
        B.terminate(`ret i1 ${matched}`);
        break;
      }
      case "func":
        this.host.declare(`declare zeroext i1 @scr_dyn_is_callable(ptr)`);
        {
          const matched = B.tmp();
          B.line(`${matched} = call zeroext i1 @scr_dyn_is_callable(ptr %d)`);
          B.terminate(`ret i1 ${matched}`);
        }
        break;
      case "classval": {
        this.host.declare(`declare zeroext i1 @scr_dyn_class_is(ptr, ptr)`);
        const matched = B.tmp();
        B.line(
          `${matched} = call zeroext i1 @scr_dyn_class_is(ptr %d, ptr ${this.host.cstr(key)})`,
        );
        B.terminate(`ret i1 ${matched}`);
        break;
      }
      case "generator":
        // Only an exact native capsule carries these channel types.
        B.terminate(`ret i1 false`);
        break;
      case "object": {
        if (t.className !== "%Error") {
          // Exact class capsules returned true before materialization.
          // Plain dyn objects carry no class brand.
          B.terminate(`ret i1 false`);
          break;
        }
        const kd = this.kindOf(B, "%d");
        const isObj = B.tmp();
        B.line(`${isObj} = icmp eq i32 ${kd}, ${DYN_KIND.OBJ}`);
        const lObj = B.newLabel("dm.err.obj");
        const lFail = B.newLabel("dm.err.fail");
        B.condBr(isObj, lObj, lFail);
        B.startBlock(lObj);
        const marker = this.objGetLit(B, "%d", "%error");
        const present = B.tmp();
        B.line(`${present} = icmp ne ptr ${marker}, null`);
        B.terminate(`ret i1 ${present}`);
        B.startBlock(lFail);
        B.terminate(`ret i1 false`);
        break;
      }
      case "record": {
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape)
          throw new InternalCompilerError(
            `llvm emitter bug: dynCheck of unknown shape ${t.shapeId}`,
          );
        const fail = B.newLabel("dm.f");
        const kd = this.kindOf(B, "%d");
        // A tuple matches a JSON ARRAY of EXACTLY its arity, positionally.
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          const isArr = B.tmp();
          B.line(`${isArr} = icmp eq i32 ${kd}, ${DYN_KIND.ARR}`);
          const l1 = B.newLabel("dm.a");
          B.condBr(isArr, l1, fail);
          B.startBlock(l1);
          const len = this.lenOf(B, "%d");
          const lenOk = B.tmp();
          B.line(`${lenOk} = icmp eq ${this.S} ${len}, ${byIndex.length}`);
          const l2 = B.newLabel("dm.l");
          B.condBr(lenOk, l2, fail);
          B.startBlock(l2);
          const items = this.itemsOf(B, "%d");
          for (const [i, f] of byIndex.entries()) {
            const e = this.itemAt(B, items, `${i}`);
            const m = B.tmp();
            B.line(
              `${m} = call zeroext i1 @${this.dynMatchHelper(f.type, preserveRefs)}(ptr ${e})`,
            );
            const ln = B.newLabel("dm.i");
            B.condBr(m, ln, fail);
            B.startBlock(ln);
          }
          B.terminate(`ret i1 true`);
          B.startBlock(fail);
          B.terminate(`ret i1 false`);
          break;
        }
        const isObj = B.tmp();
        B.line(`${isObj} = icmp eq i32 ${kd}, ${DYN_KIND.OBJ}`);
        const l0 = B.newLabel("dm.o");
        let readable = isObj;
        if (!shape.indexValue) {
          const proxy = B.tmp();
          readable = B.tmp();
          B.line(`${proxy} = icmp eq i32 ${kd}, ${DYN_KIND.PROXY}`);
          B.line(`${readable} = or i1 ${isObj}, ${proxy}`);
        }
        B.condBr(readable, l0, fail);
        B.startBlock(l0);
        // dyn ('unknown') fields match ANY value, present or missing. The
        // order index is no key.
        for (const f of shape.fields) {
          if (f.type.kind === "dyn" || f.name === KEY_ORDER_FIELD) continue;
          const { value: m, release } = this.memberRead(B, f.name, f.type);
          const lNext = B.newLabel("dm.n");
          this.pendingBail(
            B,
            "dm.read",
            () => B.line(`call void @${release}(ptr ${m})`),
            "i1 false",
          );
          const ok = B.tmp();
          B.line(`${ok} = call zeroext i1 @${this.dynMatchHelper(f.type, preserveRefs)}(ptr ${m})`);
          B.line(`call void @${release}(ptr ${m})`);
          B.condBr(ok, lNext, fail);
          B.startBlock(lNext);
        }
        // Index-signature shapes: UNDECLARED keys must fit the overflow
        // value type. A dyn value type accepts anything.
        if (shape.indexValue && shape.indexValue.kind !== "dyn") {
          this.host.declare(`declare i32 @memcmp(ptr, ptr, ${this.S})`);
          const n = this.lenOf(B, "%d");
          const entries = this.itemsOf(B, "%d");
          this.i64Loop(B, "dm.ov", n, (i, brNext) => {
            const ent = this.entryAt(B, entries, i);
            // Skip declared keys.
            for (const f of shape.fields) {
              const klen = Buffer.byteLength(f.name, "utf8");
              const lenEq = B.tmp();
              B.line(`${lenEq} = icmp eq ${this.S} ${ent.keyLen}, ${klen}`);
              const lCmp = B.newLabel("dm.kc");
              const lNo = B.newLabel("dm.kn");
              B.condBr(lenEq, lCmp, lNo);
              B.startBlock(lCmp);
              const c = B.tmp();
              const same = B.tmp();
              B.line(
                `${c} = call i32 @memcmp(ptr ${ent.key}, ptr ${this.host.cstr(f.name)}, ${this.S} ${klen}) ; ${llvmCommentText(f.name)}`,
              );
              B.line(`${same} = icmp eq i32 ${c}, 0`);
              const lNo2 = B.newLabel("dm.kn");
              const skip = B.newLabel("dm.ks");
              B.condBr(same, skip, lNo2);
              B.startBlock(skip);
              brNext();
              B.startBlock(lNo2);
              B.br(lNo);
              B.startBlock(lNo);
            }
            const ok = B.tmp();
            B.line(
              `${ok} = call zeroext i1 @${this.dynMatchHelper(shape.indexValue!, preserveRefs)}(ptr ${ent.value})`,
            );
            const lOk = B.newLabel("dm.vo");
            B.condBr(ok, lOk, fail);
            B.startBlock(lOk);
          });
        }
        B.terminate(`ret i1 true`);
        B.startBlock(fail);
        B.terminate(`ret i1 false`);
        break;
      }
      case "array": {
        const m = this.dynMatchHelper(t.elem, preserveRefs);
        const fail = B.newLabel("dm.f");
        const kd = this.kindOf(B, "%d");
        const isArr = B.tmp();
        B.line(`${isArr} = icmp eq i32 ${kd}, ${DYN_KIND.ARR}`);
        const l0 = B.newLabel("dm.a");
        B.condBr(isArr, l0, fail);
        B.startBlock(l0);
        const n = this.lenOf(B, "%d");
        const items = this.itemsOf(B, "%d");
        this.i64Loop(B, "dm.el", n, (i, brNext) => {
          this.host.declare(`declare zeroext i1 @scr_dyn_arr_has_index(ptr, ${this.S})`);
          const present = B.tmp();
          B.line(`${present} = call zeroext i1 @scr_dyn_arr_has_index(ptr %d, ${this.S} ${i})`);
          const valueLabel = B.newLabel("dm.present");
          const holeLabel = B.newLabel("dm.hole");
          B.condBr(present, valueLabel, holeLabel);
          B.startBlock(holeLabel);
          brNext();
          B.startBlock(valueLabel);
          const e = this.itemAt(B, items, i);
          const ok = B.tmp();
          B.line(`${ok} = call zeroext i1 @${m}(ptr ${e})`);
          const lOk = B.newLabel("dm.eo");
          B.condBr(ok, lOk, fail);
          B.startBlock(lOk);
        });
        B.terminate(`ret i1 true`);
        B.startBlock(fail);
        B.terminate(`ret i1 false`);
        break;
      }
      case "union": {
        const def = this.host.unionsById.get(t.unionId);
        if (!def)
          throw new InternalCompilerError(
            `llvm emitter bug: dynCheck of unknown union ${t.unionId}`,
          );
        // Arms in canonical order; any full match answers true.
        const yes = B.newLabel("dm.y");
        for (let tag = 0; tag < def.arms.length; tag++) {
          const ln = B.newLabel("dm.n");
          this.unionArmMatch(B, def, tag, yes, ln, preserveRefs);
          B.startBlock(ln);
        }
        B.terminate(`ret i1 false`);
        B.startBlock(yes);
        B.terminate(`ret i1 true`);
        break;
      }
      default: {
        const h = DYN_HANDLE_KINDS.get(t.kind);
        if (!h) throw new LlvmUnsupportedError(`dynMatch:${t.kind}`);
        const kd = this.kindOf(B, "%d");
        const isHandle = B.tmp();
        B.line(`${isHandle} = icmp eq i32 ${kd}, ${DYN_KIND.HANDLE}`);
        const lHandle = B.newLabel("dm.handle");
        const lNo = B.newLabel("dm.handle.no");
        B.condBr(isHandle, lHandle, lNo);
        B.startBlock(lHandle);
        const tagPtr = B.tmp();
        const tag = B.tmp();
        B.line(
          `${tagPtr} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(24, 20)} ; ->v.handle.tag`,
        );
        B.line(`${tag} = load i32, ptr ${tagPtr}`);
        const matched = B.tmp();
        B.line(`${matched} = icmp eq i32 ${tag}, ${DYN_HANDLE_TAG_NUM[t.kind]}`);
        B.terminate(`ret i1 ${matched}`);
        B.startBlock(lNo);
        B.terminate(`ret i1 false`);
        break;
      }
    }
    this.defs.push(
      `define internal zeroext i1 @${wrapped ? `${name}_body` : name}(ptr %d) ${FN_ATTRS} { ; matches ${key}`,
      B.render(),
      `}`,
      ``,
    );
    if (wrapped) this.emitVisitWrapper(name, t, recursive ? "match" : "visit");
    this.host.journalBuilt?.();
    return name;
  }

  /* ── schema-directed JSON.parse ───────────────────────────────── */

  private readonly jsonSchemas = new Map<string, string>();
  private readonly jsonParsers = new Map<string, string>();
  private readonly recordNameTables = new Map<string, { names: string; lens: string }>();
  /** Some emitted helper can keep a record's undeclared source: a checked
   * record builder that notes it, or a JSON schema of a closed record
   * (alloc.ts RECORD_SOURCES_GATE). */
  keepsRecordSources = false;

  /** Targets the one-pass parser (scr_json_parse_schema) can build
   * directly: number, boolean and string leaves inside arrays and records
   * (no tuple, internal '%' slot or `__proto__` member; at most 64 declared
   * fields, and at least one unless an index signature collects the
   * members), record members typed as unions of those leaves, records and
   * arrays, null and undefined (optional and nullable members; see
   * jsonUnionSupported), and index signatures whose value type is not a
   * union. Everything else keeps the checked-dynamic route alone. */
  private jsonSchemaSupported(t: IrType, visiting: Set<string>, member = false): boolean {
    switch (t.kind) {
      case "f64":
      case "bool":
      case "string":
        return true;
      case "array":
        return this.jsonSchemaSupported(t.elem, visiting);
      case "record": {
        if (visiting.has(t.shapeId)) return true;
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape || shape.tuple) return false;
        const index = shape.indexValue;
        if (shape.fields.length > 64 || (shape.fields.length === 0 && !index)) return false;
        visiting.add(t.shapeId);
        return (
          shape.fields.every(
            (f) =>
              f.name === KEY_ORDER_FIELD ||
              (!f.name.startsWith("%") &&
                f.name !== "__proto__" &&
                this.jsonSchemaSupported(f.type, visiting, true)),
          ) &&
          (!index || this.jsonSchemaSupported(index, visiting))
        );
      }
      case "union":
        return member && this.jsonUnionSupported(t, visiting);
      default:
        return false;
    }
  }

  /** A union record member the one-pass parser writes directly: every arm
   * a number, boolean, string, null, undefined, or a supported record or
   * array, with at most one record and one array arm and no discriminant.
   * Each JSON value kind then selects at most one arm, so the checked
   * route's first full match is that arm, and a value that arm rejects
   * fails every arm. */
  private jsonUnionSupported(t: IrType & { kind: "union" }, visiting: Set<string>): boolean {
    const def = this.host.unionsById.get(t.unionId);
    if (!def || def.discriminant) return false;
    let records = 0,
      arrays = 0;
    return def.arms.every((arm) => {
      switch (arm.kind) {
        case "f64":
        case "bool":
        case "string":
        case "nullT":
        case "undefinedT":
          return true;
        case "record":
          return ++records === 1 && this.jsonSchemaSupported(arm, visiting);
        case "array":
          return ++arrays === 1 && this.jsonSchemaSupported(arm, visiting);
        default:
          return false;
      }
    });
  }

  /** The ScrJsonSchema constant for t (scr_runtime.h layout). Records list
   * fields in declaration order — the order JSON.stringify writes — so the
   * runtime's next-field guess usually matches without a scan. */
  private jsonSchema(t: IrType): string {
    const key = typeKey(t);
    const existing = this.jsonSchemas.get(key);
    if (existing) return existing;
    const host = this.host;
    const S = host.sizeType;
    const name = `sc_jsch_${this.jsonSchemas.size}`;
    this.jsonSchemas.set(key, name);
    this.host.journalAllocated?.(name, "dyn.jsonSchema", [t]);
    let body: string;
    switch (t.kind) {
      case "f64":
      case "bool":
      case "string": {
        const kind = t.kind === "f64" ? 0 : t.kind === "bool" ? 1 : 2;
        body = `${S} ${kind}, ${S} 0, ptr null, ptr null, ptr null, ptr null, ptr null, ptr null, ${S} 0`;
        break;
      }
      case "array": {
        const elem = this.jsonSchema(t.elem);
        const ctor = `${name}_new`;
        this.defs.push(
          `define internal ptr @${ctor}(${S} %cap) ${FN_ATTRS} {`,
          `entry:`,
          `  %a = ${arrNewCall(host, t.elem, "%cap")}`,
          `  ret ptr %a`,
          `}`,
          ``,
        );
        body = `${S} 4, ${S} 0, ptr null, ptr @${elem}, ptr null, ptr @${ctor}, ptr ${vAdapters(host, t).release}, ptr null, ${S} 0`;
        break;
      }
      case "record": {
        const shape = host.recordsById.get(t.shapeId);
        if (!shape)
          throw new InternalCompilerError(
            `llvm emitter bug: JSON schema of unknown shape ${t.shapeId}`,
          );
        const struct = mangleRecordStruct(t.shapeId);
        const base = host.nullableUnions.fieldBase(t.shapeId);
        const index = new Map(shape.fields.map((f, i) => [f.name, i + base]));
        // The runtime names kept-source keys by this index (record-sources.ts).
        // The order index is no key: parsed values keep the table's order
        // and their source's own order.
        const order = recordSourceFieldOrder(shape).filter((name) => name !== KEY_ORDER_FIELD);
        if (recordMayKeepSource(shape)) this.keepsRecordSources = true;
        const fieldTy = `{ ptr, ${S}, ${S}, ptr }`;
        const entries = order.map((fieldName) => {
          const field = shape.fields[index.get(fieldName)! - base]!;
          const sub = this.jsonSchema(field.type);
          const offset = `ptrtoint (ptr getelementptr (%${struct}, ptr null, i64 0, i32 ${index.get(fieldName)}) to ${S})`;
          return `${fieldTy} { ptr ${host.cstr(fieldName)}, ${S} ${Buffer.byteLength(fieldName, "utf8")}, ${S} ${offset}, ptr @${sub} }`;
        });
        let fields = "null";
        if (entries.length > 0) {
          fields = `@${name}_fields`;
          this.defs.push(
            `${fields} = internal constant [${entries.length} x ${fieldTy}] [${entries.join(", ")}]`,
            ``,
          );
        }
        // An index signature's undeclared members go to the overflow map
        // after the declared fields.
        const overflow = shape.indexValue
          ? {
              elem: `@${this.jsonSchema(shape.indexValue)}`,
              offset: `ptrtoint (ptr getelementptr (%${struct}, ptr null, i64 0, i32 ${shape.fields.length + base}) to ${S})`,
            }
          : { elem: "null", offset: "0" };
        body = `${S} 3, ${S} ${entries.length}, ptr ${fields}, ptr ${overflow.elem}, ptr @${mangleRecordNew(t.shapeId)}, ptr null, ptr ${vAdapters(host, t).release}, ptr null, ${S} ${overflow.offset}`;
        break;
      }
      case "union":
        body = `${S} 5, ${S} 0, ptr null, ptr null, ptr null, ptr null, ptr null, ptr @${this.jsonUnionSchema(t, name)}, ${S} 0`;
        break;
      default:
        throw new InternalCompilerError(`llvm emitter bug: JSON schema of ${t.kind}`);
    }
    this.defs.push(
      `@${name} = internal constant { ${S}, ${S}, ptr, ptr, ptr, ptr, ptr, ptr, ${S} } { ${body} }`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /** The ScrJsonUnion descriptor of a union member (scr_json.h layout):
   * its slot representation, the arm each JSON value kind selects, and the
   * values the runtime stores for null and for a missing member. Boxed
   * unions build their boxes through `<name>_box`. */
  private jsonUnionSchema(t: IrType & { kind: "union" }, name: string): string {
    const host = this.host;
    const S = host.sizeType;
    const def = host.unionsById.get(t.unionId);
    if (!def) throw new InternalCompilerError(`llvm emitter bug: JSON schema of ${t.unionId}`);
    const nullable = host.nullableUnions.has(t.unionId);
    const inline = host.inlineUnions.record(t);
    const repr = nullable ? 0 : inline ? 1 : 2;
    // Indexed by SCR_JARM_*: null, number, boolean, string, object, array, absent.
    const armKinds = ["nullT", "f64", "bool", "string", "record", "array", "undefinedT"];
    const tags = armKinds.map((kind) => def.arms.findIndex((arm) => arm.kind === kind));
    const arms = armKinds.map((_, i) =>
      i >= 1 && i <= 5 && tags[i]! >= 0
        ? `ptr @${this.jsonSchema(def.arms[tags[i]!]!)}`
        : "ptr null",
    );
    const nullTag = tags[0]!;
    const absentTag = tags[6]!;
    const nullValue = !inline && nullTag >= 0 ? host.unitInstanceRef(t.unionId, nullTag) : "null";
    const absentValue = !inline && absentTag >= 0 ? host.absentInstanceRef(t.unionId) : "null";
    let box = "null";
    if (repr === 2) {
      box = `@${name}_box`;
      const lines = [`define internal ptr ${box}(i32 %tag, i64 %bits) ${FN_ATTRS} {`, `entry:`];
      const cases: string[] = [];
      const blocks: string[] = [];
      def.arms.forEach((arm, tag) => {
        if (arm.kind === "nullT" || arm.kind === "undefinedT") return;
        cases.push(`i32 ${tag}, label %arm${tag}`);
        blocks.push(`arm${tag}:`);
        if (arm.kind === "f64") {
          host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
          blocks.push(
            `  %f${tag} = bitcast i64 %bits to double`,
            `  %u${tag} = call ptr @scr_union_new_f64(i32 ${tag}, double %f${tag})`,
          );
        } else if (arm.kind === "bool") {
          host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
          blocks.push(
            `  %b${tag} = trunc i64 %bits to i1`,
            `  %u${tag} = call ptr @scr_union_new_bool(i32 ${tag}, i1 zeroext %b${tag})`,
          );
        } else {
          const rc = vAdapters(host, arm);
          host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
          blocks.push(
            `  %p${tag} = inttoptr i64 %bits to ptr`,
            `  %u${tag} = call ptr @scr_union_new_ref(i32 ${tag}, ptr %p${tag}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, arm)})`,
          );
        }
        blocks.push(`  ret ptr %u${tag}`);
      });
      this.defs.push(
        ...lines,
        `  switch i32 %tag, label %none [ ${cases.join(" ")} ]`,
        `none:`,
        `  unreachable`,
        ...blocks,
        `}`,
        ``,
      );
    }
    const descriptor = `${name}_union`;
    this.defs.push(
      `@${descriptor} = internal constant { ${S}, [7 x ${S}], [7 x ptr], ptr, ptr, ptr } { ${S} ${repr}, [7 x ${S}] [${tags.map((tag) => `${S} ${tag}`).join(", ")}], [7 x ptr] [${arms.join(", ")}], ptr ${nullValue}, ptr ${absentValue}, ptr ${box} }`,
      ``,
    );
    return descriptor;
  }

  /** `record.sourceSpread(built, value)`: the built record keeps value's
   * kept-source order over its own declared names. */
  emitRecordSourceSpread(B: BlockBuilder, built: string, value: string, shapeId: string): void {
    const host = this.host;
    const shape = host.recordsById.get(shapeId)!;
    this.keepsRecordSources = true;
    const names = this.recordNameTable(shapeId, shape);
    host.declare(`declare void @scr_record_source_spread(ptr, ptr, ptr, ptr, ${host.sizeType})`);
    B.line(
      `call void @scr_record_source_spread(ptr ${built}, ptr ${value}, ptr ${names.names}, ptr ${names.lens}, ${host.sizeType} ${shape.fields.length})`,
    );
  }

  /** The declared-name tables scr_record_source_note scans: parallel
   * constant arrays of field-name bytes and byte lengths in declaration
   * order (the order the record serializes), interned per shape. Internal
   * '%'-fields follow, so they never count as undeclared source keys. */
  private recordNameTable(shapeId: string, shape: IrRecordShape): { names: string; lens: string } {
    const existing = this.recordNameTables.get(shapeId);
    if (existing) return existing;
    const host = this.host;
    const S = host.sizeType;
    const base = `sc_rnames_${this.recordNameTables.size}`;
    const table = { names: `@${base}`, lens: `@${base}_lens` };
    this.recordNameTables.set(shapeId, table);
    this.host.journalAllocated?.(base, "dyn.recordNameTable", [shapeId]);
    const n = shape.fields.length;
    const names = recordSourceFieldOrder(shape);
    this.defs.push(
      `@${base} = internal constant [${n} x ptr] [${names.map((name) => `ptr ${host.cstr(name)}`).join(", ")}]`,
      `@${base}_lens = internal constant [${n} x ${S}] [${names.map((name) => `${S} ${Buffer.byteLength(name, "utf8")}`).join(", ")}]`,
      ``,
    );
    this.host.journalBuilt?.();
    return table;
  }

  /** `sc_jp_<n>(ptr text) -> T` for `JSON.parse(text) as T`, or null when T
   * is not a schema target. Tries the one-pass schema parser; when it
   * declines (any input the checked route might reject or read
   * differently), runs the checked-dynamic route — scr_json_parse plus the
   * dynCheck builder — which reports the exact error. Returns +1, or null
   * with the pending flag set. */
  jsonParseHelper(t: IrType): string | null {
    if (t.kind !== "record" && t.kind !== "array") return null;
    const key = typeKey(t);
    const existing = this.jsonParsers.get(key);
    if (existing) return existing;
    if (!this.jsonSchemaSupported(t, new Set())) return null;
    const host = this.host;
    const name = `sc_jp_${this.jsonParsers.size}`;
    this.jsonParsers.set(key, name);
    this.host.journalAllocated?.(name, "dyn.jsonParseHelper", [t]);
    const schema = this.jsonSchema(t);
    const check = this.dynCheckHelper(t);
    host.declare(`declare ptr @scr_json_parse_schema(ptr, ptr)`);
    host.declare(`declare ptr @scr_json_parse(ptr)`);
    host.declare(`declare void @scr_dyn_release(ptr)`);
    this.defs.push(
      `define internal ptr @${name}(ptr %text) ${FN_ATTRS} { ; JSON.parse as ${llvmCommentText(key)}`,
      `entry:`,
      `  %fast = call ptr @scr_json_parse_schema(ptr %text, ptr @${schema})`,
      `  %hit = icmp ne ptr %fast, null`,
      `  br i1 %hit, label %done, label %slow`,
      `done:`,
      `  ret ptr %fast`,
      `slow:`,
      `  %d = call ptr @scr_json_parse(ptr %text)`,
      `  %bad = icmp eq ptr %d, null`,
      `  br i1 %bad, label %fail, label %check`,
      `fail:`,
      `  ret ptr null`,
      `check:`,
      `  %v = call ptr @${check}(ptr %d, ptr null)`,
      `  call void @scr_dyn_release(ptr %d)`,
      `  ret ptr %v`,
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── dynCheckHelper (walkers.ts, ported) ──────────────────────── */

  /** `sc_dc_<n>(ptr d, ptr path) -> T` — validate the checked-dynamic tree against T and
   * BUILD the typed value (+1), or throw the catchable path-annotated
   * TypeError and return a dummy with the pending flag set. */
  dynCheckHelper(t: IrType, preserveRefs = false): string {
    const key = typeKey(t);
    const builderKey = preserveRefs ? `identity:${key}` : key;
    const existing = this.dynBuilders.get(builderKey);
    if (existing) return existing;
    const name = `sc_dc_${this.dynBuilders.size}`;
    this.dynBuilders.set(builderKey, name);
    this.host.journalAllocated?.(name, "dyn.dynCheckHelper", [t, preserveRefs]);
    const recursive = this.isRecursiveShape(t);
    const memo = !recursive && this.holdsRecursiveShape(t) && this.valTy(t) === "ptr";
    const host = this.host;
    const retTy = this.valTy(t);
    const dummy =
      retTy === "double" ? `double ${f64Lit(0)}` : retTy === "i1" ? "i1 false" : "ptr null";
    host.declare(`declare void @scr_dyn_check_fail(ptr, ptr, ptr)`);
    const want = host.cstr(dynDesc(t, this.host.recordsById, this.host.unionsById));
    const B = new BlockBuilder();
    if (t.kind === "classval") {
      host.declare(`declare ptr @scr_dyn_class_check(ptr, ptr, ptr)`);
      const checked = B.tmp();
      B.line(
        `${checked} = call ptr @scr_dyn_class_check(ptr %d, ptr ${host.cstr(key)}, ptr %path)`,
      );
      B.terminate(`ret ptr ${checked}`);
      this.defs.push(
        `define internal ptr @${name}(ptr %d, ptr %path) ${FN_ATTRS} {`,
        B.render(),
        `}`,
        ``,
      );
      this.host.journalBuilt?.();
      return name;
    }
    const codec = textCodecRecordClass(t, (id) => host.recordsById.get(id));
    if (codec !== null) {
      // The record the codec's handle box holds (+1), or the path TypeError.
      host.declare(`declare ptr @scr_text_codec_from_dyn(ptr, i1 zeroext, ptr, ptr)`);
      const checked = B.tmp();
      B.line(
        `${checked} = call ptr @scr_text_codec_from_dyn(ptr %d, i1 ${codec === "TextDecoder"}, ptr %path, ptr ${want})`,
      );
      B.terminate(`ret ptr ${checked}`);
      this.defs.push(
        `define internal ptr @${name}(ptr %d, ptr %path) ${FN_ATTRS} {`,
        B.render(),
        `}`,
        ``,
      );
      this.host.journalBuilt?.();
      return name;
    }
    if (isRefCounted(t) && t.kind !== "dyn") {
      host.declare(`declare ptr @scr_dyn_typed_ref_unbox(ptr)`);
      if (t.kind === "object" && t.className === "%Error") {
        host.declare(`declare ptr @scr_errdyn_err_of(ptr)`);
        const error = B.tmp(),
          found = B.tmp();
        B.line(`${error} = call ptr @scr_errdyn_err_of(ptr %d)`);
        B.line(`${found} = icmp ne ptr ${error}, null`);
        const yes = B.newLabel("dc.error"),
          next = B.newLabel("dc.noterror");
        B.condBr(found, yes, next);
        B.startBlock(yes);
        B.terminate(`ret ptr ${error}`);
        B.startBlock(next);
      }
      if (isDynTypedRefType(t)) this.exactClassCapsule(B, t);
      const matched = this.typedRefMatches(B, t);
      const lRef = B.newLabel("dc.tr");
      const lNext = B.newLabel("dc.nt");
      B.condBr(matched, lRef, lNext);
      B.startBlock(lRef);
      const ref = B.tmp();
      B.line(`${ref} = call ptr @scr_dyn_typed_ref_unbox(ptr %d)`);
      B.terminate(`ret ptr ${ref}`);
      B.startBlock(lNext);
      // A constructor-function stream (scr_dyn_builtin_stream.c) carries
      // its runtime stream.
      const streamKind = t.kind === "object" ? builtinStreamKind(t.className) : null;
      if (streamKind !== null && this.host.usesDynBuiltinStream?.() === true) {
        host.declare(`declare ptr @scr_dyn_builtin_stream_check(ptr, double)`);
        const own = B.tmp(),
          hit = B.tmp();
        B.line(
          `${own} = call ptr @scr_dyn_builtin_stream_check(ptr %d, double ${f64Lit(streamKind)})`,
        );
        B.line(`${hit} = icmp ne ptr ${own}, null`);
        const lOwn = B.newLabel("dc.ctor"),
          lNotOwn = B.newLabel("dc.notctor");
        B.condBr(hit, lOwn, lNotOwn);
        B.startBlock(lOwn);
        B.terminate(`ret ptr ${own}`);
        B.startBlock(lNotOwn);
      }
      if (t.kind !== "union" && preserveRefs) {
        const kind = this.kindOf(B, "%d");
        const capsule = B.tmp();
        B.line(`${capsule} = icmp eq i32 ${kind}, ${DYN_KIND.TYPED_REF}`);
        const reject = B.newLabel("dc.identity.reject");
        const plain = B.newLabel("dc.identity.plain");
        B.condBr(capsule, reject, plain);
        B.startBlock(reject);
        B.line(
          `call void @scr_dyn_check_fail(ptr %path, ptr ${host.cstr("reference with its original layout")}, ptr %d)`,
        );
        B.terminate(`ret ${dummy}`);
        B.startBlock(plain);
      } else if (t.kind !== "union") {
        const view = this.viewFn(recursive || memo);
        host.declare(`declare ptr @scr_dyn_typed_ref_cached_cast(ptr, ptr, ${host.sizeType})`);
        host.declare(
          `declare void @scr_dyn_typed_ref_cache_cast(ptr, ptr, ${host.sizeType}, ptr, ptr, ptr, i1)`,
        );
        host.declare(`declare void @scr_dyn_release_v(ptr)`);
        const rc = vAdapters(host, t);
        const kind = this.kindOf(B, "%d");
        const capsule = B.tmp();
        B.line(`${capsule} = icmp eq i32 ${kind}, ${DYN_KIND.TYPED_REF}`);
        const lCapsule = B.newLabel("dc.tr.cap");
        const lPlain = B.newLabel("dc.tr.plain");
        B.condBr(capsule, lCapsule, lPlain);
        B.startBlock(lCapsule);
        const cached = B.tmp();
        B.line(
          `${cached} = call ptr @scr_dyn_typed_ref_cached_cast(ptr %d, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")})`,
        );
        const hasCached = B.tmp();
        B.line(`${hasCached} = icmp ne ptr ${cached}, null`);
        if (recursive) {
          // A cached record keeps its identity: the refresh below rewrites
          // it in place. Later visits of this capsule in the session answer
          // it, instead of refreshing it while this visit rebuilds it.
          host.declare(`declare void @scr_dyn_build_note(ptr, ptr, ptr)`);
          B.line(`call void @scr_dyn_build_note(ptr %d, ptr @${name}, ptr ${cached})`);
        }
        if (t.kind !== "record" && t.kind !== "array") {
          const lCached = B.newLabel("dc.tr.hit");
          const lMaterialize = B.newLabel("dc.tr.mat");
          B.condBr(hasCached, lCached, lMaterialize);
          B.startBlock(lCached);
          B.terminate(`ret ptr ${cached}`);
          B.startBlock(lMaterialize);
        }
        const materialized = B.tmp();
        const checked = B.tmp();
        B.line(`${materialized} = call ptr @${view}(ptr %d)`);
        B.line(`${checked} = call ${retTy} @${name}(ptr ${materialized}, ptr %path)`);
        B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
        const ok = B.tmp();
        B.line(`${ok} = icmp ne ptr ${checked}, null`);
        if (t.kind === "record" || t.kind === "array") {
          const shape = t.kind === "record" ? host.recordsById.get(t.shapeId) : undefined;
          if (t.kind === "record" && !shape) {
            throw new InternalCompilerError(
              `llvm emitter bug: cached typed-ref cast of unknown shape ${t.shapeId}`,
            );
          }
          const lOk = B.newLabel("dc.tr.ok");
          const lBad = B.newLabel("dc.tr.bad");
          B.condBr(ok, lOk, lBad);
          B.startBlock(lBad);
          const lBadDrop = B.newLabel("dc.tr.bad.drop");
          const lBadRet = B.newLabel("dc.tr.bad.ret");
          B.condBr(hasCached, lBadDrop, lBadRet);
          B.startBlock(lBadDrop);
          B.line(`call void ${releaseSym(host, t)}(ptr ${cached})`);
          B.br(lBadRet);
          B.startBlock(lBadRet);
          B.terminate(`ret ptr null`);
          B.startBlock(lOk);
          const lRefresh = B.newLabel("dc.tr.refresh");
          const lCache = B.newLabel("dc.tr.put");
          B.condBr(hasCached, lRefresh, lCache);
          B.startBlock(lRefresh);
          if (t.kind !== "record") {
            // Inline slots live in each header's block; move them out
            // before the storage pointers change hands.
            host.declare("declare void @scr_arr_outline(ptr)");
            B.line(`call void @scr_arr_outline(ptr ${cached})`);
            B.line(`call void @scr_arr_outline(ptr ${checked})`);
          }
          const base = t.kind === "record" ? host.nullableUnions.fieldBase(t.shapeId) : 1;
          const members =
            t.kind === "record"
              ? [
                  ...shape!.fields.map((field, index) => ({
                    index: index + base,
                    type: llFieldType(field.type, host.inlineUnions.record(field.type)),
                    name: field.name,
                  })),
                  ...(shape!.indexValue
                    ? [
                        {
                          index: shape!.fields.length + base,
                          type: "ptr" as const,
                          name: "[key: string] overflow",
                        },
                      ]
                    : []),
                ]
              : [
                  // The dense states follow the data slots: they move with data and capacity.
                  { index: SCR_ARR_FIELD.len, type: "i32", name: "length" },
                  { index: SCR_ARR_FIELD.cap, type: "i32", name: "capacity" },
                  { index: SCR_ARR_FIELD.data, type: "ptr" as const, name: "data" },
                  { index: SCR_ARR_FIELD.filled, type: "i32" as const, name: "filled" },
                ];
          members.forEach((member) => {
            const cachedPtr = B.tmp();
            const checkedPtr = B.tmp();
            const oldValue = B.tmp();
            const newValue = B.tmp();
            const struct = t.kind === "record" ? `%${mangleRecordStruct(t.shapeId)}` : "%ScrArr";
            B.line(
              `${cachedPtr} = getelementptr inbounds ${struct}, ptr ${cached}, i64 0, i32 ${member.index}`,
            );
            B.line(
              `${checkedPtr} = getelementptr inbounds ${struct}, ptr ${checked}, i64 0, i32 ${member.index}`,
            );
            B.line(
              `${oldValue} = load ${member.type}, ptr ${cachedPtr} ; ${llvmCommentText(member.name)}`,
            );
            B.line(`${newValue} = load ${member.type}, ptr ${checkedPtr}`);
            B.line(`store ${member.type} ${newValue}, ptr ${cachedPtr}`);
            B.line(`store ${member.type} ${oldValue}, ptr ${checkedPtr}`);
          });
          if (t.kind !== "record") {
            // Whether the dense slots carry states (SCR_ARR_STATES in
            // `spare`) moves with them; the rest of `spare` stays.
            const cachedSpare = B.tmp(),
              checkedSpare = B.tmp();
            const sparePtr = (array: string): string => {
              const ptr = B.tmp();
              B.line(
                `${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i64 0, i32 ${SCR_ARR_FIELD.spare}`,
              );
              return ptr;
            };
            const cachedSparePtr = sparePtr(cached),
              checkedSparePtr = sparePtr(checked);
            B.line(`${cachedSpare} = load i16, ptr ${cachedSparePtr}`);
            B.line(`${checkedSpare} = load i16, ptr ${checkedSparePtr}`);
            const exchange = (own: string, other: string, ptr: string): void => {
              const kept = B.tmp(),
                moved = B.tmp(),
                next = B.tmp();
              B.line(`${kept} = and i16 ${own}, ${~SCR_ARR_STATES}`);
              B.line(`${moved} = and i16 ${other}, ${SCR_ARR_STATES}`);
              B.line(`${next} = or i16 ${kept}, ${moved}`);
              B.line(`store i16 ${next}, ptr ${ptr}`);
            };
            exchange(cachedSpare, checkedSpare, cachedSparePtr);
            exchange(checkedSpare, cachedSpare, checkedSparePtr);
            // Sparse slots and numeric properties live out of line; each
            // array keeps its own match metadata.
            host.declare("declare void @scr_arr_swap_indexed_ext(ptr, ptr)");
            B.line(`call void @scr_arr_swap_indexed_ext(ptr ${cached}, ptr ${checked})`);
          }
          if (recursive) {
            // The memo recorded the record built for the view: later visits
            // in the session answer the cached record that now holds it.
            host.declare(`declare void @scr_dyn_build_rekey(ptr, ptr, ptr)`);
            B.line(
              `call void @scr_dyn_build_rekey(ptr ${materialized}, ptr @${name}, ptr ${cached})`,
            );
          }
          B.line(`call void ${releaseSym(host, t)}(ptr ${checked})`);
          B.terminate(`ret ptr ${cached}`);
          B.startBlock(lCache);
          B.line(
            `call void @scr_dyn_typed_ref_cache_cast(ptr %d, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr ${checked}, ptr ${rc.retain}, ptr ${rc.release}, i1 ${traceAdapter(host, t) !== null ? "true" : "false"})`,
          );
          B.terminate(`ret ptr ${checked}`);
        } else {
          const lCache = B.newLabel("dc.tr.put");
          const lReturn = B.newLabel("dc.tr.ret");
          B.condBr(ok, lCache, lReturn);
          B.startBlock(lCache);
          B.line(
            `call void @scr_dyn_typed_ref_cache_cast(ptr %d, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr ${checked}, ptr ${rc.retain}, ptr ${rc.release}, i1 ${traceAdapter(host, t) !== null ? "true" : "false"})`,
          );
          B.br(lReturn);
          B.startBlock(lReturn);
          B.terminate(`ret ptr ${checked}`);
        }
        B.startBlock(lPlain);
      }
    }
    /** kind test with the standard fail path (got = %d). */
    const requireKind = (k: number, hint: string): void => {
      const kd = this.kindOf(B, "%d");
      const ok = B.tmp();
      B.line(`${ok} = icmp eq i32 ${kd}, ${k}`);
      const lo = B.newLabel(`${hint}.k`);
      const lf = B.newLabel(`${hint}.f`);
      B.condBr(ok, lo, lf);
      B.startBlock(lf);
      B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
      B.terminate(`ret ${dummy}`);
      B.startBlock(lo);
    };
    switch (t.kind) {
      case "date": {
        host.declare(`declare ptr @scr_dyn_native_date_check(ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_date_check(ptr %d, ptr %path)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "url":
      case "searchParams": {
        const native = t.kind === "url" ? "url" : "search_params";
        host.declare(`declare ptr @scr_dyn_native_${native}_check(ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_${native}_check(ptr %d, ptr %path)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "regex": {
        host.declare(`declare ptr @scr_dyn_native_regex_check(ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_regex_check(ptr %d, ptr %path)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "map":
      case "set": {
        host.declare(`declare ptr @scr_dyn_native_collection_check(ptr, i32, ptr, ptr)`);
        const r = B.tmp();
        const typed =
          t.kind === "map" ? t.key.kind !== "dyn" || t.value.kind !== "dyn" : t.elem.kind !== "dyn";
        B.line(
          `${r} = call ptr @scr_dyn_native_collection_check(ptr %d, i32 ${t.kind === "map" ? 1 : 0}, ptr ${typed ? host.cstr(typeKey(t)) : "null"}, ptr %path)`,
        );
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "bigint": {
        requireKind(DYN_KIND.BIGINT, "dc");
        host.declare(`declare ptr @scr_bigint_retain(ptr)`);
        const v = this.payloadOf(B, "%d", "ptr");
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_bigint_retain(ptr ${v})`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "symbol": {
        requireKind(DYN_KIND.SYMBOL, "dc");
        host.declare(`declare ptr @scr_sym_retain(ptr)`);
        const v = this.payloadOf(B, "%d", "ptr");
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_sym_retain(ptr ${v})`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "f64": {
        requireKind(DYN_KIND.NUM, "dc");
        const v = this.payloadOf(B, "%d", "double");
        B.terminate(`ret double ${v}`);
        break;
      }
      case "bool": {
        requireKind(DYN_KIND.BOOL, "dc");
        const v = this.boolOf(B, "%d");
        B.terminate(`ret i1 ${v}`);
        break;
      }
      case "string": {
        requireKind(DYN_KIND.STR, "dc");
        host.declare(`declare ptr @scr_str_retain_v(ptr)`);
        const s = this.payloadOf(B, "%d", "ptr");
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_str_retain_v(ptr ${s})`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "dyn": {
        // Preserve the capsule at an unknown boundary. Generic dyn
        // operations materialize its one cached detached view, while
        // strict equality keeps repeated stream references identical.
        const retained = this.retainDyn(B, "%d");
        B.terminate(`ret ptr ${retained}`);
        break;
      }
      case "procStream": {
        host.declare(`declare double @scr_dyn_process_stdio_fd(ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call double @scr_dyn_process_stdio_fd(ptr %d, ptr %path)`);
        B.terminate(`ret double ${r}`);
        break;
      }
      case "bytes": {
        host.declare(`declare zeroext i1 @scr_dyn_bytes_is(ptr, i32)`);
        const matched = B.tmp();
        B.line(
          `${matched} = call zeroext i1 @scr_dyn_bytes_is(ptr %d, i32 ${BYTES_ELEM_NUM[t.elem]})`,
        );
        const yes = B.newLabel("dc.bytes");
        const no = B.newLabel("dc.bytes.fail");
        B.condBr(matched, yes, no);
        B.startBlock(no);
        B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
        B.terminate(`ret ptr null`);
        B.startBlock(yes);
        host.declare(`declare ptr @scr_dyn_bytes_unbox(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_bytes_unbox(ptr %d)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "generator":
        B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
        B.terminate(`ret ptr null`);
        break;
      case "promise": {
        requireKind(DYN_KIND.PROMISE, "dc");
        host.declare(`declare ptr @scr_promise_retain(ptr)`);
        const promise = this.payloadOf(B, "%d", "ptr"),
          retained = B.tmp();
        if (t.inner.kind !== "dyn") {
          host.declare(`declare ptr @scr_promise_new()`);
          host.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
          B.line(`${retained} = call ptr @scr_promise_new()`);
          host.declare(`declare void @scr_promise_share_identity(ptr, ptr)`);
          B.line(`call void @scr_promise_share_identity(ptr ${retained}, ptr ${promise})`);
          B.line(
            `call void @scr_promise_race_add(ptr ${retained}, ptr ${promise}, ptr @${host.dynPromiseAdapter(t.inner)})`,
          );
          B.terminate(`ret ptr ${retained}`);
          break;
        }
        B.line(`${retained} = call ptr @scr_promise_retain(ptr ${promise})`);
        B.terminate(`ret ptr ${retained}`);
        break;
      }
      case "object": {
        // The %Error extraction (an instanceof-Error narrow on unknown):
        // validate the checked-dynamic tree's error encoding — the reserved "%error" marker
        // caughtToDyn builds — and extract through the runtime's IDENTITY
        // CACHE (scr_error_from_dyn): a dyn error that came from a runtime
        // ScrError answers that very instance, so out-and-back crossings
        // compare reference-equal (the tracing suite's shape); alien
        // %error objects rebuild once and cache the pair. The C walker's
        // arm exactly.
        if (t.className !== "%Error") {
          // Exact class capsules returned before this switch. A plain dyn
          // object cannot acquire a class brand structurally.
          B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
          B.terminate(`ret ptr null`);
          break;
        }
        const kd = this.kindOf(B, "%d");
        const isObj = B.tmp();
        B.line(`${isObj} = icmp eq i32 ${kd}, ${DYN_KIND.OBJ}`);
        const lObj = B.newLabel("dce.o");
        const lFail = B.newLabel("dce.f");
        B.condBr(isObj, lObj, lFail);
        B.startBlock(lObj);
        const marker = this.objGetLit(B, "%d", "%error");
        const hasMarker = B.tmp();
        B.line(`${hasMarker} = icmp ne ptr ${marker}, null`);
        const lGo = B.newLabel("dce.g");
        B.condBr(hasMarker, lGo, lFail);
        B.startBlock(lFail);
        B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
        B.terminate(`ret ptr null`);
        B.startBlock(lGo);
        host.declare(`declare ptr @scr_error_from_dyn(ptr)`);
        const e = B.tmp();
        B.line(`${e} = call ptr @scr_error_from_dyn(ptr %d)`);
        B.terminate(`ret ptr ${e}`);
        break;
      }
      case "record": {
        const shape = host.recordsById.get(t.shapeId);
        if (!shape)
          throw new InternalCompilerError(
            `llvm emitter bug: dynCheck of unknown shape ${t.shapeId}`,
          );
        const struct = mangleRecordStruct(t.shapeId);
        const base = host.nullableUnions.fieldBase(t.shapeId);
        const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + base]));
        const releaseR = (): void => {
          B.line(`call void ${releaseSym(host, t)}(ptr %r0)`);
        };
        // One shared path node, restored per use (lives only during the
        // nested call).
        const pathSlot = "%dcp";
        B.entryAllocas.push(`${pathSlot} = alloca %ScrDynPath`);
        const setPath = (keyText: string | null, index: string): void => {
          const pp = B.tmp();
          const kp = B.tmp();
          const ip = B.tmp();
          B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
          B.line(`store ptr %path, ptr ${pp}`);
          B.line(`${kp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
          B.line(`store ptr ${keyText === null ? "null" : host.cstr(keyText)}, ptr ${kp}`);
          B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
          B.line(`store ${host.sizeType} ${index}, ptr ${ip}`);
        };
        const setPathKeyPtr = (keyPtr: string): void => {
          const pp = B.tmp();
          const kp = B.tmp();
          const ip = B.tmp();
          B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
          B.line(`store ptr %path, ptr ${pp}`);
          B.line(`${kp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
          B.line(`store ptr ${keyPtr}, ptr ${kp}`);
          B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
          B.line(`store ${host.sizeType} 0, ptr ${ip}`);
        };
        // An inline union field copies the checked box's bits; the caller
        // releases the box afterwards.
        const storeInto = (fieldName: string, ft: IrType, value: string): void => {
          const idx = fieldIndex.get(fieldName)!;
          const p = B.tmp();
          B.line(
            `${p} = getelementptr inbounds %${struct}, ptr %r0, i64 0, i32 ${idx} ; .${llvmCommentText(fieldName)}`,
          );
          const fieldTy = llFieldType(ft, host.inlineUnions.record(ft));
          if (fieldTy === INLINE_UNION_FIELD) {
            const { tag, bits } = unionBoxBits(B, value, host.unionNoneRef());
            storeInlineUnion(B, p, tag, bits);
          } else if (fieldTy === "i8") {
            const z = B.tmp();
            B.line(`${z} = zext i1 ${value} to i8`);
            B.line(`store i8 ${z}, ptr ${p}`);
          } else {
            B.line(`store ${fieldTy} ${value}, ptr ${p}`);
          }
        };
        const releaseInline = (ft: IrType, value: string): void => {
          if (host.inlineUnions.record(ft))
            B.line(`call void ${releaseSym(host, ft)}(ptr ${value})`);
        };
        // Tuple targets: a JSON ARRAY of exactly the arity.
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          const arityWant = host.cstr(`array of length ${byIndex.length}`);
          requireKind(DYN_KIND.ARR, "dct");
          const len = this.lenOf(B, "%d");
          const lenOk = B.tmp();
          B.line(`${lenOk} = icmp eq ${host.sizeType} ${len}, ${byIndex.length}`);
          const lGo = B.newLabel("dct.g");
          const lAr = B.newLabel("dct.a");
          B.condBr(lenOk, lGo, lAr);
          B.startBlock(lAr);
          B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${arityWant}, ptr %d)`);
          B.terminate(`ret ptr null`);
          B.startBlock(lGo);
          B.line(`%r0 = call ptr @${mangleRecordNew(t.shapeId)}()`);
          if (recursive) this.recordBuilt(B, name, "%r0");
          const items = this.itemsOf(B, "%d");
          byIndex.forEach((f, i) => {
            setPath(null, `${i}`);
            const e = this.itemAt(B, items, `${i}`);
            const v = B.tmp();
            B.line(
              `${v} = call ${this.valTy(f.type)} @${this.dynCheckHelper(f.type, preserveRefs)}(ptr ${e}, ptr ${pathSlot})`,
            );
            storeInto(f.name, f.type, v);
            releaseInline(f.type, v);
            this.pendingBail(B, "dct", releaseR, "ptr null");
          });
          B.terminate(`ret ptr %r0`);
          break;
        }
        if (shape.indexValue) requireKind(DYN_KIND.OBJ, "dcr");
        else {
          const kind = this.kindOf(B, "%d"),
            object = B.tmp(),
            proxy = B.tmp(),
            readable = B.tmp();
          B.line(`${object} = icmp eq i32 ${kind}, ${DYN_KIND.OBJ}`);
          B.line(`${proxy} = icmp eq i32 ${kind}, ${DYN_KIND.PROXY}`);
          B.line(`${readable} = or i1 ${object}, ${proxy}`);
          const ok = B.newLabel("dcr.object"),
            fail = B.newLabel("dcr.fail");
          B.condBr(readable, ok, fail);
          B.startBlock(fail);
          B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
          B.terminate(`ret ptr null`);
          B.startBlock(ok);
        }
        if (shape.fields.length === 0 && !shape.indexValue) {
          const sourceAccessor = `${this.toDynHelper(t)}_source_access`;
          const rc = vAdapters(host, t);
          host.declare(`declare ptr @scr_dyn_obj_source_cast(ptr, ptr, ptr)`);
          const source = B.tmp();
          const found = B.tmp();
          const lSource = B.newLabel("dcr.source");
          const lCopy = B.newLabel("dcr.copy");
          B.line(
            `${source} = call ptr @scr_dyn_obj_source_cast(ptr %d, ptr @${sourceAccessor}, ptr ${rc.retain})`,
          );
          B.line(`${found} = icmp ne ptr ${source}, null`);
          B.condBr(found, lSource, lCopy);
          B.startBlock(lSource);
          B.terminate(`ret ptr ${source}`);
          B.startBlock(lCopy);
        }
        B.line(`%r0 = call ptr @${mangleRecordNew(t.shapeId)}()`);
        if (recursive) this.recordBuilt(B, name, "%r0");
        // The order index stays 0: the source's own order is kept below
        // when it differs from the table.
        for (const f of shape.fields) {
          if (f.name === KEY_ORDER_FIELD) continue;
          const { value: m, release } = this.memberRead(B, f.name, f.type);
          this.pendingBail(
            B,
            "dcr.read",
            () => {
              B.line(`call void @${release}(ptr ${m})`);
              releaseR();
            },
            "ptr null",
          );
          setPath(f.name, "0");
          const value = B.tmp();
          B.line(
            `${value} = call ${this.valTy(f.type)} @${this.dynCheckHelper(f.type, preserveRefs)}(ptr ${m}, ptr ${pathSlot})`,
          );
          B.line(`call void @${release}(ptr ${m})`);
          storeInto(f.name, f.type, value);
          this.pendingBail(
            B,
            "dcr",
            () => {
              releaseInline(f.type, value);
              releaseR();
            },
            "ptr null",
          );
          if (f.type.kind === "union") {
            const stored = this.presenceOf(B, "%d", f.name, f.type, value);
            if (stored !== value) storeInto(f.name, f.type, stored);
          }
          releaseInline(f.type, value);
        }
        // A closed layout cannot store undeclared keys: a source object
        // that has them stays beside the record so its reflective
        // surfaces still observe them (scr_record_source_note).
        if (recordMayKeepSource(shape)) {
          this.keepsRecordSources = true;
          const names = this.recordNameTable(t.shapeId, shape);
          host.declare(
            `declare void @scr_record_source_note(ptr, ptr, ptr, ptr, ${host.sizeType})`,
          );
          B.line(
            `call void @scr_record_source_note(ptr %r0, ptr %d, ptr ${names.names}, ptr ${names.lens}, ${host.sizeType} ${shape.fields.length})`,
          );
        }
        // Index-signature shapes CAPTURE undeclared keys into the
        // overflow map.
        if (shape.indexValue) {
          const iv = shape.indexValue;
          host.declare(`declare i32 @memcmp(ptr, ptr, ${host.sizeType})`);
          host.declare(`declare ptr @scr_str_new(ptr, ${host.sizeType})`);
          host.declare(`declare void @scr_str_release(ptr)`);
          const ovfp = B.tmp();
          const ovf = B.tmp();
          B.line(
            `${ovfp} = getelementptr inbounds %${struct}, ptr %r0, i64 0, i32 ${shape.fields.length + base}`,
          );
          B.line(`${ovf} = load ptr, ptr ${ovfp} ; overflow map`);
          if (shape.fields.length === 0) {
            // Object.create(null)'s dictionary keeps its null prototype:
            // ScrDyn.null_proto becomes SCR_MAP_NULL_PROTO.
            const npp = B.tmp();
            const np = B.tmp();
            const flagsp = B.tmp();
            B.line(
              `${npp} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(13, 9)} ; ->null_proto`,
            );
            B.line(`${np} = load i8, ptr ${npp}`);
            B.line(
              `${flagsp} = getelementptr inbounds i8, ptr ${ovf}, i64 ${mapFlagsOffset(host.sizeType)}`,
            );
            B.line(`store i8 ${np}, ptr ${flagsp}`);
          }
          const n = this.lenOf(B, "%d");
          const entries = this.itemsOf(B, "%d");
          this.i64Loop(B, "dcv", n, (i, brNext) => {
            const ent = this.entryAt(B, entries, i);
            for (const f of shape.fields) {
              const klen = Buffer.byteLength(f.name, "utf8");
              const lenEq = B.tmp();
              B.line(`${lenEq} = icmp eq ${host.sizeType} ${ent.keyLen}, ${klen}`);
              const lCmp = B.newLabel("dcv.kc");
              const lNo = B.newLabel("dcv.kn");
              B.condBr(lenEq, lCmp, lNo);
              B.startBlock(lCmp);
              const c = B.tmp();
              const same = B.tmp();
              B.line(
                `${c} = call i32 @memcmp(ptr ${ent.key}, ptr ${host.cstr(f.name)}, ${host.sizeType} ${klen}) ; ${llvmCommentText(f.name)}`,
              );
              B.line(`${same} = icmp eq i32 ${c}, 0`);
              const skip = B.newLabel("dcv.ks");
              const lNo2 = B.newLabel("dcv.kn");
              B.condBr(same, skip, lNo2);
              B.startBlock(skip);
              brNext();
              B.startBlock(lNo2);
              B.br(lNo);
              B.startBlock(lNo);
            }
            let ev: string;
            if (iv.kind === "dyn") {
              ev = this.retainDyn(B, ent.value);
            } else {
              setPathKeyPtr(ent.key);
              ev = B.tmp();
              B.line(
                `${ev} = call ${this.valTy(iv)} @${this.dynCheckHelper(iv, preserveRefs)}(ptr ${ent.value}, ptr ${pathSlot})`,
              );
              this.pendingBail(B, "dcv", releaseR, "ptr null");
            }
            const ek = B.tmp();
            B.line(`${ek} = call ptr @scr_str_new(ptr ${ent.key}, ${host.sizeType} ${ent.keyLen})`);
            if (iv.kind === "f64") {
              host.declare(`declare void @scr_map_set_str_f64(ptr, ptr, double)`);
              B.line(`call void @scr_map_set_str_f64(ptr ${ovf}, ptr ${ek}, double ${ev})`);
            } else if (iv.kind === "bool") {
              host.declare(`declare void @scr_map_set_str_bool(ptr, ptr, i1 zeroext)`);
              B.line(`call void @scr_map_set_str_bool(ptr ${ovf}, ptr ${ek}, i1 ${ev})`);
            } else {
              host.declare(`declare void @scr_map_set_str_ref(ptr, ptr, ptr)`);
              B.line(
                `call void @scr_map_set_str_ref(ptr ${ovf}, ptr ${ek}, ptr ${ev}) ; v moves in`,
              );
            }
            B.line(`call void @scr_str_release(ptr ${ek})`);
          });
        }
        B.terminate(`ret ptr %r0`);
        break;
      }
      case "array": {
        const elem = t.elem;
        const c = this.dynCheckHelper(elem, preserveRefs);
        requireKind(DYN_KIND.ARR, "dca");
        const n = this.lenOf(B, "%d");
        const a = B.tmp();
        B.line(`${a} = ${arrNewCall(host, elem, n)}`);
        if (recursive) this.recordBuilt(B, name, a);
        const items = this.itemsOf(B, "%d");
        const pathSlot = "%dcp";
        B.entryAllocas.push(`${pathSlot} = alloca %ScrDynPath`);
        const acc = elemAccess(elem);
        const accTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
        host.declare(
          `declare double @scr_arr_push_${acc}(ptr, ${acc === "bool" ? "i1 zeroext" : accTy})`,
        );
        this.i64Loop(B, "dca", n, (i) => {
          host.declare(`declare zeroext i1 @scr_dyn_arr_has_index(ptr, ${this.S})`);
          const present = B.tmp();
          B.line(`${present} = call zeroext i1 @scr_dyn_arr_has_index(ptr %d, ${this.S} ${i})`);
          const valueLabel = B.newLabel("dca.present");
          const holeLabel = B.newLabel("dca.hole");
          const doneLabel = B.newLabel("dca.done");
          B.condBr(present, valueLabel, holeLabel);
          B.startBlock(holeLabel);
          host.declare(`declare void @scr_arr_set_len(ptr, double)`);
          const index = B.tmp();
          const length = B.tmp();
          B.line(`${index} = ${sizeToDouble(this.S)} ${this.S} ${i} to double`);
          B.line(`${length} = fadd double ${index}, 1.0`);
          B.line(`call void @scr_arr_set_len(ptr ${a}, double ${length})`);
          B.br(doneLabel);
          B.startBlock(valueLabel);
          const pp = B.tmp();
          const kp = B.tmp();
          const ip = B.tmp();
          B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
          B.line(`store ptr %path, ptr ${pp}`);
          B.line(`${kp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
          B.line(`store ptr null, ptr ${kp}`);
          B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
          B.line(`store ${host.sizeType} ${i}, ptr ${ip}`);
          const e = this.itemAt(B, items, i);
          const v = B.tmp();
          B.line(`${v} = call ${this.valTy(elem)} @${c}(ptr ${e}, ptr ${pathSlot})`);
          this.pendingBail(
            B,
            "dca",
            () => {
              host.declare(`declare void @scr_arr_release(ptr)`);
              B.line(`call void @scr_arr_release(ptr ${a})`);
            },
            "ptr null",
          );
          const pushed = B.tmp();
          B.line(`${pushed} = call double @scr_arr_push_${acc}(ptr ${a}, ${accTy} ${v})`);
          B.br(doneLabel);
          B.startBlock(doneLabel);
        });
        B.terminate(`ret ptr ${a}`);
        break;
      }
      case "union": {
        const def = host.unionsById.get(t.unionId);
        if (!def)
          throw new InternalCompilerError(
            `llvm emitter bug: dynCheck of unknown union ${t.unionId}`,
          );
        // Arms in unionArmOrder, first FULL match wins. The matched arm's
        // builder can no longer fail.
        for (const i of this.unionArmOrder(def)) {
          const arm = def.arms[i]!;
          const lHit = B.newLabel("dcu.h");
          const lNext = B.newLabel("dcu.n");
          this.unionArmMatch(B, def, i, lHit, lNext, preserveRefs);
          B.startBlock(lHit);
          if (arm.kind === "undefinedT" || arm.kind === "nullT") {
            // A matched unit arm builds nothing: THE interned immortal
            // instance (rc == SIZE_MAX — no retain owed).
            B.terminate(`ret ptr ${host.unitInstanceRef(t.unionId, i)}`);
          } else if (arm.kind === "f64" || arm.kind === "procStream") {
            host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
            const x = B.tmp();
            const u = B.tmp();
            B.line(
              `${x} = call double @${this.dynCheckHelper(arm, preserveRefs)}(ptr %d, ptr %path)`,
            );
            B.line(`${u} = call ptr @scr_union_new_f64(i32 ${i}, double ${x})`);
            B.terminate(`ret ptr ${u}`);
          } else if (arm.kind === "bool") {
            host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
            const x = B.tmp();
            const u = B.tmp();
            B.line(
              `${x} = call zeroext i1 @${this.dynCheckHelper(arm, preserveRefs)}(ptr %d, ptr %path)`,
            );
            B.line(`${u} = call ptr @scr_union_new_bool(i32 ${i}, i1 ${x})`);
            B.terminate(`ret ptr ${u}`);
          } else if (host.nullableUnions.has(t.unionId)) {
            // A nullable union is its (+1) reference payload.
            const x = B.tmp();
            B.line(`${x} = call ptr @${this.dynCheckHelper(arm, preserveRefs)}(ptr %d, ptr %path)`);
            B.terminate(`ret ptr ${x}`);
          } else {
            const rc = vAdapters(host, arm);
            host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
            const x = B.tmp();
            const u = B.tmp();
            B.line(`${x} = call ptr @${this.dynCheckHelper(arm, preserveRefs)}(ptr %d, ptr %path)`);
            B.line(
              `${u} = call ptr @scr_union_new_ref(i32 ${i}, ptr ${x}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, arm)})`,
            );
            B.terminate(`ret ptr ${u}`);
          }
          B.startBlock(lNext);
        }
        if (preserveRefs) {
          B.line(
            `call void @scr_dyn_check_fail(ptr %path, ptr ${host.cstr("reference with its original layout")}, ptr %d)`,
          );
          B.terminate(`ret ptr null`);
          break;
        }
        // Preserve an exact typed-ref arm above. If no producer tag matched,
        // retry the union against the ordinary copy-based structural
        // snapshot (the compiler's width-coercion stance, rather than a
        // live narrowed alias).
        const view = this.viewFn(recursive || memo);
        host.declare(`declare ptr @scr_dyn_typed_ref_cached_cast(ptr, ptr, ${host.sizeType})`);
        host.declare(
          `declare void @scr_dyn_typed_ref_cache_cast(ptr, ptr, ${host.sizeType}, ptr, ptr, ptr, i1)`,
        );
        host.declare(`declare void @scr_dyn_release_v(ptr)`);
        host.declare(`declare void @scr_union_release(ptr)`);
        const rc = vAdapters(host, t);
        const kind = this.kindOf(B, "%d");
        const capsule = B.tmp();
        B.line(`${capsule} = icmp eq i32 ${kind}, ${DYN_KIND.TYPED_REF}`);
        const lCapsule = B.newLabel("dcu.cap");
        const lFail = B.newLabel("dcu.fail");
        B.condBr(capsule, lCapsule, lFail);
        B.startBlock(lCapsule);
        if (host.nullableUnions.has(t.unionId)) {
          // No box identity to cache: the structural snapshot's payload is
          // the value, and NULL is the undefined arm, so failure is the
          // pending exception rather than a NULL result.
          const materialized = B.tmp();
          const checked = B.tmp();
          B.line(`${materialized} = call ptr @${view}(ptr %d)`);
          B.line(`${checked} = call ptr @${name}(ptr ${materialized}, ptr %path)`);
          B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
          B.terminate(`ret ptr ${checked}`);
          B.startBlock(lFail);
          this.unionArmFailure(B, def, kind);
          B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
          B.terminate(`ret ptr null`);
          break;
        }
        const cached = B.tmp();
        B.line(
          `${cached} = call ptr @scr_dyn_typed_ref_cached_cast(ptr %d, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")})`,
        );
        const hasCached = B.tmp();
        B.line(`${hasCached} = icmp ne ptr ${cached}, null`);
        const materialized = B.tmp();
        const checked = B.tmp();
        B.line(`${materialized} = call ptr @${view}(ptr %d)`);
        B.line(`${checked} = call ptr @${name}(ptr ${materialized}, ptr %path)`);
        B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
        const ok = B.tmp();
        B.line(`${ok} = icmp ne ptr ${checked}, null`);
        const lOk = B.newLabel("dcu.ok");
        const lBad = B.newLabel("dcu.bad");
        B.condBr(ok, lOk, lBad);
        B.startBlock(lBad);
        const lBadDrop = B.newLabel("dcu.bad.drop");
        const lBadRet = B.newLabel("dcu.bad.ret");
        B.condBr(hasCached, lBadDrop, lBadRet);
        B.startBlock(lBadDrop);
        B.line(`call void @scr_union_release(ptr ${cached})`);
        B.br(lBadRet);
        B.startBlock(lBadRet);
        B.terminate(`ret ptr null`);
        B.startBlock(lOk);
        const lRefresh = B.newLabel("dcu.refresh");
        const lCache = B.newLabel("dcu.put");
        B.condBr(hasCached, lRefresh, lCache);
        B.startBlock(lRefresh);
        const fields: [number, string, string][] = [
          [1, "i32", "tag"],
          [2, "ptr", "retain"],
          [3, "ptr", "release"],
          [4, "ptr", "trace"],
          [5, "i64", "slot"],
        ];
        fields.forEach(([index, fieldType, fieldName]) => {
          const cachedPtr = B.tmp();
          const checkedPtr = B.tmp();
          const oldValue = B.tmp();
          const newValue = B.tmp();
          B.line(
            `${cachedPtr} = getelementptr inbounds %ScrUnion, ptr ${cached}, i64 0, i32 ${index}`,
          );
          B.line(
            `${checkedPtr} = getelementptr inbounds %ScrUnion, ptr ${checked}, i64 0, i32 ${index}`,
          );
          B.line(`${oldValue} = load ${fieldType}, ptr ${cachedPtr} ; ${fieldName}`);
          B.line(`${newValue} = load ${fieldType}, ptr ${checkedPtr}`);
          B.line(`store ${fieldType} ${newValue}, ptr ${cachedPtr}`);
          B.line(`store ${fieldType} ${oldValue}, ptr ${checkedPtr}`);
        });
        B.line(`call void @scr_union_release(ptr ${checked})`);
        B.terminate(`ret ptr ${cached}`);
        B.startBlock(lCache);
        // Later casts refresh this box in place (above), so from now on
        // retypes of this union must not share a box (unionRetype).
        B.line(`store i8 1, ptr ${host.retypeGuardRef(t.unionId)}`);
        B.line(
          `call void @scr_dyn_typed_ref_cache_cast(ptr %d, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr ${checked}, ptr ${rc.retain}, ptr ${rc.release}, i1 ${traceAdapter(host, t) !== null ? "true" : "false"})`,
        );
        B.terminate(`ret ptr ${checked}`);
        B.startBlock(lFail);
        this.unionArmFailure(B, def, kind);
        B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
        B.terminate(`ret ptr null`);
        break;
      }
      case "func": {
        // The checked-dynamic function boundary, OUT direction: an
        // IDENTICAL boxed signature unwraps the closure directly;
        // anything else wraps in the per-target adapter closure whose
        // caps[0] obj-box owns the dyn value (untraced).
        const adapter = this.dynFuncAdapterHelper(t);
        const sigLit = host.cstr(key);
        const lWrap = B.newLabel("dcf.w");
        host.declare(`declare zeroext i1 @scr_dyn_is_callable(ptr)`);
        const callable = B.tmp();
        const valid = B.newLabel("dcf.k");
        const invalid = B.newLabel("dcf.f");
        B.line(`${callable} = call zeroext i1 @scr_dyn_is_callable(ptr %d)`);
        B.condBr(callable, valid, invalid);
        B.startBlock(invalid);
        B.line(`call void @scr_dyn_check_fail(ptr %path, ptr ${want}, ptr %d)`);
        B.terminate(`ret ${dummy}`);
        B.startBlock(valid);
        const direct = B.tmp();
        const lSignature = B.newLabel("dcf.signature");
        B.line(`${direct} = icmp eq i32 ${this.kindOf(B, "%d")}, ${DYN_KIND.FUNC}`);
        B.condBr(direct, lSignature, lWrap);
        B.startBlock(lSignature);
        host.declare(`declare i32 @strcmp(ptr, ptr)`);
        const sigp = B.tmp();
        const sig = B.tmp();
        B.line(
          `${sigp} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(32, 24)} ; ->v.fn.sig`,
        );
        B.line(`${sig} = load ptr, ptr ${sigp}`);
        const cmp = B.tmp();
        const same = B.tmp();
        B.line(`${cmp} = call i32 @strcmp(ptr ${sig}, ptr ${sigLit})`);
        B.line(`${same} = icmp eq i32 ${cmp}, 0`);
        const lSame = B.newLabel("dcf.s");
        B.condBr(same, lSame, lWrap);
        B.startBlock(lSame);
        host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        const clop = B.tmp();
        const clo = B.tmp();
        const r = B.tmp();
        B.line(`${clop} = getelementptr inbounds i8, ptr %d, i64 16 ; ->v.fn.clo`);
        B.line(`${clo} = load ptr, ptr ${clop}`);
        B.line(`${r} = call ptr @scr_closure_retain_v(ptr ${clo})`);
        B.terminate(`ret ptr ${r}`);
        B.startBlock(lWrap);
        host.declare(`declare ptr @scr_closure_new(ptr, ${host.sizeType})`);
        host.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
        host.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
        host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
        host.declare(`declare void @scr_dyn_trace_v(ptr, ptr, ptr)`);
        host.declare(`declare void @scr_dyn_release_v(ptr)`);
        const a = B.tmp();
        B.line(`${a} = call ptr @scr_closure_new(ptr @${adapter}, ${host.sizeType} 1)`);
        host.declare(`declare i32 @scr_dyn_function_kind(ptr)`);
        const functionKind = B.tmp();
        const targetKind = B.tmp();
        B.line(`${functionKind} = call i32 @scr_dyn_function_kind(ptr %d)`);
        B.line(`${targetKind} = getelementptr inbounds %ScrClosure, ptr ${a}, i64 0, i32 4`);
        const adapterKind = B.tmp();
        B.line(
          `${adapterKind} = or i32 ${functionKind}, 8 ; preserves the checked callable in caps[0]`,
        );
        B.line(`store i32 ${adapterKind}, ptr ${targetKind}`);
        const box = B.tmp();
        B.line(
          `${box} = call ptr @scr_box_new_obj(ptr @scr_dyn_retain_v, ptr @scr_dyn_release_v, ptr @scr_dyn_trace_v)`,
        );
        const capp = B.tmp();
        B.line(`${capp} = getelementptr inbounds %ScrClosure, ptr ${a}, i64 1 ; caps[0]`);
        B.line(`store ptr ${box}, ptr ${capp}`);
        const rd = this.retainDyn(B, "%d");
        B.line(`call void @scr_box_set_ref(ptr ${box}, ptr ${rd})`);
        // The shim is the same JS function under another signature: it
        // takes the boxed closure's identity (kept alive through caps[0]).
        host.declare(`declare void @scr_dyn_adopt_identity(ptr, ptr)`);
        B.line(`call void @scr_dyn_adopt_identity(ptr ${a}, ptr %d)`);
        B.terminate(`ret ptr ${a}`);
        break;
      }
      default: {
        // Runtime HANDLE targets: a tag-checked reference unwrap (+1 —
        // identity, no copy; the runtime throws the path-annotated
        // TypeError on any other kind or tag).
        const h = DYN_HANDLE_KINDS.get(t.kind);
        if (h) {
          const r = B.tmp();
          const unbox = DYN_HANDLE_UNBOX_FN[t.kind];
          if (unbox) {
            host.declare(`declare ptr @${unbox}(ptr, ptr, ptr)`);
            B.line(`${r} = call ptr @${unbox}(ptr %d, ptr %path, ptr ${want})`);
          } else {
            host.declare(`declare ptr @scr_dyn_handle_unbox(ptr, i32, ptr, ptr)`);
            B.line(
              `${r} = call ptr @scr_dyn_handle_unbox(ptr %d, i32 ${DYN_HANDLE_TAG_NUM[t.kind]}, ptr %path, ptr ${want})`,
            );
          }
          B.terminate(`ret ptr ${r}`);
          break;
        }
        throw new LlvmUnsupportedError(`type:${t.kind}`);
      }
    }
    this.defs.push(
      `define internal ${retTy === "i1" ? "zeroext i1" : retTy} @${recursive || memo ? `${name}_body` : name}(ptr %d, ptr %path) ${FN_ATTRS} { ; check ${key}`,
      B.render(),
      `}`,
      ``,
    );
    if (recursive || memo) this.emitVisitWrapper(name, t, recursive ? "build" : "memo");
    this.host.journalBuilt?.();
    return name;
  }

  /** `i1`: %d is a handle box with tag `tag`. */
  private handleTagMatches(B: BlockBuilder, tag: number): string {
    const kd = this.kindOf(B, "%d");
    const isHandle = B.tmp();
    B.line(`${isHandle} = icmp eq i32 ${kd}, ${DYN_KIND.HANDLE}`);
    const lHandle = B.newLabel("dm.handle");
    const lDone = B.newLabel("dm.handle.done");
    const entry = B.currentLabel();
    B.condBr(isHandle, lHandle, lDone);
    B.startBlock(lHandle);
    const tagPtr = B.tmp();
    const loaded = B.tmp();
    B.line(
      `${tagPtr} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(24, 20)} ; ->v.handle.tag`,
    );
    B.line(`${loaded} = load i32, ptr ${tagPtr}`);
    const same = B.tmp();
    B.line(`${same} = icmp eq i32 ${loaded}, ${tag}`);
    B.br(lDone);
    B.startBlock(lDone);
    const matched = B.tmp();
    B.line(`${matched} = phi i1 [ false, %${entry} ], [ ${same}, %${lHandle} ]`);
    return matched;
  }

  /** A TextEncoder or TextDecoder record boxes as its handle (+1), which
   * holds the record by reference. A decoder passes the byte offsets of the
   * fields its boxed decode reads. */
  private textCodecToDyn(
    B: BlockBuilder,
    t: IrType & { kind: "record" },
    shape: IrRecordShape,
    codec: "TextEncoder" | "TextDecoder",
  ): void {
    const host = this.host;
    const rc = vAdapters(host, t);
    const r = B.tmp();
    if (codec === "TextEncoder") {
      host.declare(`declare ptr @scr_text_encoder_to_dyn(ptr, ptr, ptr)`);
      B.line(
        `${r} = call ptr @scr_text_encoder_to_dyn(ptr %v, ptr ${rc.retain}, ptr ${rc.release})`,
      );
    } else {
      const struct = mangleRecordStruct(t.shapeId);
      const base = host.nullableUnions.fieldBase(t.shapeId);
      const start = B.tmp();
      B.line(`${start} = ptrtoint ptr %v to ${this.S}`);
      const offsets = TEXT_DECODER_FIELDS.map((field) => {
        const index = shape.fields.findIndex((f) => f.name === field);
        if (index < 0)
          throw new InternalCompilerError(`llvm emitter bug: TextDecoder record lacks ${field}`);
        const p = B.tmp();
        const at = B.tmp();
        const offset = B.tmp();
        B.line(
          `${p} = getelementptr inbounds %${struct}, ptr %v, i64 0, i32 ${index + base} ; .${llvmCommentText(field)}`,
        );
        B.line(`${at} = ptrtoint ptr ${p} to ${this.S}`);
        B.line(`${offset} = sub ${this.S} ${at}, ${start}`);
        return `${this.S} ${offset}`;
      });
      host.declare(
        `declare ptr @scr_text_decoder_to_dyn(ptr, ptr, ptr, ${this.S}, ${this.S}, ${this.S}, ${this.S})`,
      );
      B.line(
        `${r} = call ptr @scr_text_decoder_to_dyn(ptr %v, ptr ${rc.retain}, ptr ${rc.release}, ${offsets.join(", ")})`,
      );
    }
    B.terminate(`ret ptr ${r}`);
  }

  /* ── toDynHelper (walkers.ts, ported) ─────────────────────────── */

  /** `sc_td_<n>(<T> v) -> ptr` — build a fresh dyn value from a
   * static one (+1), DEEP-COPYING composites. Borrows the operand.
   * Never throws. */
  toDynHelper(t: IrType): string {
    const key = typeKey(t);
    const existing = this.toDynFns.get(key);
    if (existing) return existing;
    const name = `sc_td_${this.toDynFns.size}`;
    this.toDynFns.set(key, name);
    this.host.journalAllocated?.(name, "dyn.toDynHelper", [t]);
    const host = this.host;
    const B = new BlockBuilder();
    let sourceAccessor: { name: string; release: string } | null = null;
    switch (t.kind) {
      case "date": {
        // A Date handle holding the same Date object.
        host.declare(`declare ptr @scr_dyn_native_date(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_date(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "url":
      case "searchParams": {
        const native = t.kind === "url" ? "url" : "search_params";
        host.declare(`declare ptr @scr_dyn_native_${native}(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_${native}(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "regex": {
        host.declare(`declare ptr @scr_dyn_native_regex(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_regex(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "map":
      case "set": {
        host.declare(`declare ptr @scr_dyn_native_${t.kind}(ptr)`);
        if (
          t.kind === "map" ? t.key.kind !== "dyn" || t.value.kind !== "dyn" : t.elem.kind !== "dyn"
        ) {
          host.declare(`declare void @scr_map_dyn_attach(ptr, ptr)`);
          B.line(`call void @scr_map_dyn_attach(ptr %v, ptr @${this.collectionDynOps(t)})`);
        }
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_native_${t.kind}(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "bigint": {
        host.declare(`declare ptr @scr_dyn_new_bigint(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_bigint(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "symbol": {
        host.declare(`declare ptr @scr_dyn_new_symbol(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_symbol(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "f64": {
        host.declare(`declare ptr @scr_dyn_new_num(double)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_num(double %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "bool": {
        host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_bool(i1 %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "procStream": {
        host.declare(`declare ptr @scr_process_stdio(double)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_process_stdio(double %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "string": {
        host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_str(ptr %v) ; retains v`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "generator": {
        // Keep the suspended fiber and its channels by identity. Member
        // calls are generated from the exact capsule key by the frontend.
        const rc = vAdapters(host, t);
        const r = B.tmp();
        const snapshot = `${name}_snapshot`;
        const message =
          "property reflection on a native generator through an untyped value is not supported yet";
        host.declare(`declare void @scr_throw_error_msg_code(i32, ptr, ${host.sizeType}, ptr)`);
        this.defs.push(
          `define internal ptr @${snapshot}(ptr %v) ${FN_ATTRS} {`,
          `entry:`,
          `  call void @scr_throw_error_msg_code(i32 0, ptr ${host.cstr(message)}, ${host.sizeType} ${Buffer.byteLength(message, "utf8")}, ptr ${host.cstr("SC1071")})`,
          `  ret ptr null`,
          `}`,
          ``,
        );
        B.line(
          `${r} = call ptr ${typedRefConstructor(host, t)}(ptr %v, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${snapshot}, ptr null)`,
        );
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "object": {
        const className = t.className;
        if (host.isErrorClass(className)) {
          host.declare(`declare ptr @scr_dyn_from_error(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call ptr @scr_dyn_from_error(ptr %v)`);
          B.terminate(`ret ptr ${r}`);
          break;
        }
        if (!isDynTypedRefType(t)) {
          throw new InternalCompilerError(`llvm emitter bug: to-dyn of runtime class ${className}`);
        }
        const adapter = host.liveDynRefAdapter(t);
        const rc = vAdapters(host, t);
        const keyLit = host.cstr(typeKey(t));

        const r = B.tmp();
        B.line(
          `${r} = call ptr ${typedRefConstructor(host, t)}(ptr %v, ptr ${rc.retain}, ptr ${rc.release}, ptr ${keyLit}, ${host.sizeType} ${Buffer.byteLength(typeKey(t), "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
        );
        // The same live view as a direct box: class members for `in` and
        // the class name for inspection.
        for (const line of bindLiveArrayOps(host, adapter, r)) B.line(line);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "dyn": {
        const r = this.retainDyn(B, "%v");
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "classval": {
        host.declare(`declare ptr @scr_dyn_new_class(ptr, ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_class(ptr %v, ptr ${host.cstr(key)})`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "func": {
        const r = B.tmp();
        B.line(`${r} = call ptr @${this.dynFuncBoxHelper(t)}(ptr %v, ptr null)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "bytes": {
        host.declare(`declare ptr @scr_dyn_new_bytes(ptr)`);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_bytes(ptr %v)`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      case "record": {
        const shape = host.recordsById.get(t.shapeId);
        if (!shape)
          throw new InternalCompilerError(`llvm emitter bug: to-dyn of unknown shape ${t.shapeId}`);
        const codec = recordTextCodecClass(shape);
        if (codec !== null) {
          this.textCodecToDyn(B, t, shape, codec);
          break;
        }
        const struct = mangleRecordStruct(t.shapeId);
        const base = host.nullableUnions.fieldBase(t.shapeId);
        const fieldIndex = new Map(shape.fields.map((f, i) => [f.name, i + base]));
        const loadFieldOf = (fname: string, ft: IrType): string => {
          const p = B.tmp();
          B.line(
            `${p} = getelementptr inbounds %${struct}, ptr %v, i64 0, i32 ${fieldIndex.get(fname)!} ; .${llvmCommentText(fname)}`,
          );
          // An inline union field lends a private stack box (ABSENT kept).
          if (host.inlineUnions.record(ft)) {
            const { tag, bits } = loadInlineUnion(B, p);
            return stackUnionBox(B, host.sizeType, tag, bits);
          }
          const raw = B.tmp();
          B.line(`${raw} = load ${llFieldType(ft, false)}, ptr ${p}`);
          if (llFieldType(ft, false) !== "i8") return raw;
          const b = B.tmp();
          B.line(`${b} = trunc i8 ${raw} to i1`);
          return b;
        };
        host.declare(`declare void @scr_dyn_obj_set(ptr, ptr, ${host.sizeType}, ptr)`);
        // CYCLE-CAPABLE shapes guard the deep copy: enter TRAPS on a value
        // already being converted (a cyclic value has no finite dyn copy —
        // SEMANTICS.md).
        const cyclicRec = traceAdapter(host, t) !== null;
        if (cyclicRec) {
          host.declare(`declare void @scr_dyn_from_enter(ptr)`);
          host.declare(`declare void @scr_dyn_from_leave()`);
          B.line(`call void @scr_dyn_from_enter(ptr %v)`);
        }
        if (shape.tuple) {
          // A tuple converts as the JSON ARRAY it is everywhere else.
          host.declare(`declare ptr @scr_dyn_new_arr()`);
          host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          const d = B.tmp();
          B.line(`${d} = call ptr @scr_dyn_new_arr()`);
          for (const f of byIndex) {
            const fv = loadFieldOf(f.name, f.type);
            const conv = B.tmp();
            B.line(`${conv} = call ptr @${this.toDynHelper(f.type)}(${this.valTy(f.type)} ${fv})`);
            B.line(`call void @scr_dyn_arr_push(ptr ${d}, ptr ${conv})`);
          }
          if (cyclicRec) B.line(`call void @scr_dyn_from_leave()`);
          host.declare(`declare ptr @scr_dyn_mark_snapshot(ptr)`);
          B.line(`call ptr @scr_dyn_mark_snapshot(ptr ${d})`);
          B.terminate(`ret ptr ${d}`);
          break;
        }
        const d = B.tmp();
        if (recordDynKeepsIdentity(shape)) {
          const rc = vAdapters(host, t);
          sourceAccessor = {
            name: `${name}_source_access`,
            release: rc.release,
          };
          host.declare(`declare ptr @scr_dyn_new_obj_with_identity(ptr, ptr, ptr)`);
          B.line(
            `${d} = call ptr @scr_dyn_new_obj_with_identity(ptr %v, ptr ${rc.retain}, ptr @${sourceAccessor.name})`,
          );
        } else if (shape.indexValue && shape.fields.length === 0) {
          // A pure index-signature record keeps a null prototype
          // (SCR_MAP_NULL_PROTO on its overflow map; Object.groupBy).
          host.declare(`declare ptr @scr_dyn_new_obj()`);
          host.declare(`declare ptr @scr_dyn_new_obj_null_proto()`);
          const ovfp = B.tmp();
          const ovf = B.tmp();
          const flagsp = B.tmp();
          const flags = B.tmp();
          const np = B.tmp();
          const alloc = B.tmp();
          B.line(`${ovfp} = getelementptr inbounds %${struct}, ptr %v, i64 0, i32 1`);
          B.line(`${ovf} = load ptr, ptr ${ovfp} ; overflow map`);
          B.line(
            `${flagsp} = getelementptr inbounds i8, ptr ${ovf}, i64 ${mapFlagsOffset(host.sizeType)}`,
          );
          B.line(`${flags} = load i8, ptr ${flagsp}`);
          B.line(`${np} = icmp ne i8 ${flags}, 0`);
          B.line(
            `${alloc} = select i1 ${np}, ptr @scr_dyn_new_obj_null_proto, ptr @scr_dyn_new_obj`,
          );
          B.line(`${d} = call ptr ${alloc}()`);
        } else {
          host.declare(`declare ptr @scr_dyn_new_obj()`);
          B.line(`${d} = call ptr @scr_dyn_new_obj()`);
        }
        // Keys insert in DECLARED order (JS insertion order), or in the
        // value's own order for a shape with orderVariants; internal
        // '%'-fields follow so a record→dyn→record round trip keeps them
        // (all but the order index, which is no key).
        const byName = new Map(shape.fields.map((f) => [f.name, f]));
        // An accessor property is one key whose getter and setter are the
        // slot closures (see accessorSlotProp), in accessorOrder's place.
        const orders =
          shape.accessorOrder !== undefined ? [shape.accessorOrder] : shapeKeyOrders(shape);
        const perOrder = (order: readonly string[]): void => {
          const inOrder = new Set(order);
          const accessors = new Set(
            shape.accessorOrder === undefined
              ? []
              : shape.fields.flatMap((f) => {
                  const slot = accessorSlotProp(f.name);
                  return slot === null ? [] : [slot.prop];
                }),
          );
          type DynField = { name: string; type: IrType } | { accessor: string };
          const dynFields: DynField[] = [
            ...order.flatMap((n) => {
              if (accessors.has(n)) return [{ accessor: n } as DynField];
              const f = byName.get(n);
              return f === undefined ? [] : [f as DynField];
            }),
            ...shape.fields.filter(
              (f) =>
                !inOrder.has(f.name) &&
                f.name !== KEY_ORDER_FIELD &&
                !(accessors.size > 0 && accessorSlotProp(f.name) !== null),
            ),
          ];
          for (const entry of dynFields) {
            if ("accessor" in entry) {
              host.declare(
                `declare void @scr_dyn_obj_set_accessor(ptr, ptr, ${host.sizeType}, ptr, ptr)`,
              );
              const boxed = (kind: "get" | "set"): string => {
                const slot = byName.get(`%${kind}:${entry.accessor}`);
                if (slot === undefined) return "null";
                const fv = loadFieldOf(slot.name, slot.type);
                const conv = B.tmp();
                B.line(
                  `${conv} = call ptr @${this.toDynHelper(slot.type)}(${this.valTy(slot.type)} ${fv})`,
                );
                return conv;
              };
              const getter = boxed("get");
              const setter = boxed("set");
              B.line(
                `call void @scr_dyn_obj_set_accessor(ptr ${d}, ptr ${host.cstr(entry.accessor)}, ${host.sizeType} ${Buffer.byteLength(entry.accessor, "utf8")}, ptr ${getter}, ptr ${setter}) ; ${llvmCommentText(entry.accessor)}`,
              );
              continue;
            }
            const f = entry;
            const klen = Buffer.byteLength(f.name, "utf8");
            const fv = loadFieldOf(f.name, f.type);
            // An ABSENT optional field contributes no key.
            const lSkip = f.type.kind === "union" ? this.skipIfAbsent(B, fv, f.type) : null;
            const conv = B.tmp();
            B.line(`${conv} = call ptr @${this.toDynHelper(f.type)}(${this.valTy(f.type)} ${fv})`);
            B.line(
              `call void @scr_dyn_obj_set(ptr ${d}, ptr ${host.cstr(f.name)}, ${host.sizeType} ${klen}, ptr ${conv}) ; ${llvmCommentText(f.name)}`,
            );
            if (lSkip !== null) {
              B.br(lSkip);
              B.startBlock(lSkip);
            }
          }
        };
        if (orders.length === 1) perOrder(orders[0]!);
        else emitPerKeyOrder(B, shape, base, "%v", perOrder);
        // A Dirent row takes Node's Dirent prototype (the type probes) and
        // its Symbol(type) key; %dtype stays readable but non-enumerable.
        if (isDirentShape(shape)) {
          host.declare(`declare void @scr_dyn_dirent_finish(ptr)`);
          B.line(`call void @scr_dyn_dirent_finish(ptr ${d})`);
        }
        if (shape.indexValue) {
          const iv = shape.indexValue;
          host.declare(`declare ptr @scr_map_keys_js_order(ptr)`);
          host.declare(`declare double @scr_arr_len(ptr)`);
          host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
          host.declare(`declare void @scr_str_release(ptr)`);
          host.declare(`declare void @scr_arr_release(ptr)`);
          const ovfp = B.tmp();
          const ovf = B.tmp();
          B.line(
            `${ovfp} = getelementptr inbounds %${struct}, ptr %v, i64 0, i32 ${shape.fields.length + base}`,
          );
          B.line(`${ovf} = load ptr, ptr ${ovfp} ; overflow map`);
          const ks = B.tmp();
          const len = B.tmp();
          B.line(`${ks} = call ptr @scr_map_keys_js_order(ptr ${ovf})`);
          B.line(`${len} = call double @scr_arr_len(ptr ${ks})`);
          B.countedLoop(len, (i) => {
            const k = B.tmp();
            B.line(`${k} = call ptr @scr_arr_get_ref(ptr ${ks}, double ${i}) ; key (+1)`);
            const { len: klen, data: kdata } = this.strParts(B, k);
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
              let val = raw;
              if (iv.kind === "bool") {
                val = B.tmp();
                B.line(`${val} = trunc i8 ${raw} to i1`);
              }
              const boxed = B.tmp();
              if (iv.kind === "f64") {
                host.declare(`declare ptr @scr_dyn_new_num(double)`);
                B.line(`${boxed} = call ptr @scr_dyn_new_num(double ${val})`);
              } else {
                host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
                B.line(`${boxed} = call ptr @scr_dyn_new_bool(i1 ${val})`);
              }
              B.line(
                `call void @scr_dyn_obj_set(ptr ${d}, ptr ${kdata}, ${host.sizeType} ${klen}, ptr ${boxed})`,
              );
            } else if (iv.kind === "dyn") {
              // get_str_ref returns +1 — exactly the ownership obj_set takes.
              host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
              const hit = B.tmp();
              B.line(`${hit} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${k})`);
              B.line(
                `call void @scr_dyn_obj_set(ptr ${d}, ptr ${kdata}, ${host.sizeType} ${klen}, ptr ${hit})`,
              );
            } else {
              host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
              const hit = B.tmp();
              B.line(`${hit} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${k})`);
              const conv = B.tmp();
              B.line(`${conv} = call ptr @${this.toDynHelper(iv)}(ptr ${hit})`);
              B.line(
                `call void @scr_dyn_obj_set(ptr ${d}, ptr ${kdata}, ${host.sizeType} ${klen}, ptr ${conv})`,
              );
              B.line(`call void ${releaseSym(host, iv)}(ptr ${hit})`);
            }
            B.line(`call void @scr_str_release(ptr ${k})`);
          });
          B.line(`call void @scr_arr_release(ptr ${ks})`);
        }
        if (cyclicRec) B.line(`call void @scr_dyn_from_leave()`);
        let snapshot = d;
        if (!shape.indexValue && !recordDynKeepsIdentity(shape)) {
          // Undeclared properties the record kept from its checked source
          // rejoin the copy in their own-key positions.
          host.declare(`declare ptr @scr_record_source_apply(ptr, ptr)`);
          snapshot = B.tmp();
          B.line(`${snapshot} = call ptr @scr_record_source_apply(ptr ${d}, ptr %v)`);
        }
        host.declare(`declare ptr @scr_dyn_mark_snapshot(ptr)`);
        B.line(`call ptr @scr_dyn_mark_snapshot(ptr ${snapshot})`);
        B.terminate(`ret ptr ${snapshot}`);
        break;
      }
      case "array": {
        const elem = t.elem;
        host.declare(`declare ptr @scr_dyn_new_arr()`);
        host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
        host.declare(`declare double @scr_arr_len(ptr)`);
        // Cycle-capable arrays guard the deep copy like records above.
        const cyclicArr = traceAdapter(host, t) !== null;
        if (cyclicArr) {
          host.declare(`declare void @scr_dyn_from_enter(ptr)`);
          host.declare(`declare void @scr_dyn_from_leave()`);
          B.line(`call void @scr_dyn_from_enter(ptr %v)`);
        }
        const d = B.tmp();
        B.line(`${d} = call ptr @scr_dyn_new_arr()`);
        const len = B.tmp();
        B.line(`${len} = call double @scr_arr_len(ptr %v)`);
        B.countedLoop(len, (i) => {
          host.declare(`declare double @scr_arr_state(ptr, double)`);
          const state = B.tmp();
          const undefinedState = B.tmp();
          const undefinedLabel = B.newLabel("tda.undefined");
          const holeLabel = B.newLabel("tda.hole");
          const presentLabel = B.newLabel("tda.present");
          const valueLabel = B.newLabel("tda.value");
          const doneLabel = B.newLabel("tda.done");
          B.line(`${state} = call double @scr_arr_state(ptr %v, double ${i})`);
          const hole = B.tmp();
          B.line(`${hole} = fcmp oeq double ${state}, 0.0`); // SCR_ARR_HOLE
          B.condBr(hole, holeLabel, presentLabel);
          B.startBlock(holeLabel);
          host.declare(`declare void @scr_dyn_arr_push_hole(ptr)`);
          B.line(`call void @scr_dyn_arr_push_hole(ptr ${d})`);
          B.br(doneLabel);
          B.startBlock(presentLabel);
          B.line(`${undefinedState} = fcmp oeq double ${state}, 2.0`); // SCR_ARR_UNDEFINED
          B.terminate(`br i1 ${undefinedState}, label %${undefinedLabel}, label %${valueLabel}`);
          B.startBlock(undefinedLabel);
          const retained = this.retainDyn(B, this.undef(B));
          B.line(`call void @scr_dyn_arr_push(ptr ${d}, ptr ${retained})`);
          B.terminate(`br label %${doneLabel}`);
          B.startBlock(valueLabel);
          if (elem.kind === "f64" || elem.kind === "bool") {
            const acc = elem.kind;
            const accTy = elem.kind === "f64" ? "double" : "i1";
            host.declare(
              `declare ${elem.kind === "bool" ? "zeroext i1" : accTy} @scr_arr_get_${acc}(ptr, double)`,
            );
            const e = B.tmp();
            B.line(`${e} = call ${accTy} @scr_arr_get_${acc}(ptr %v, double ${i})`);
            const boxed = B.tmp();
            if (elem.kind === "f64") {
              host.declare(`declare ptr @scr_dyn_new_num(double)`);
              B.line(`${boxed} = call ptr @scr_dyn_new_num(double ${e})`);
            } else {
              host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
              B.line(`${boxed} = call ptr @scr_dyn_new_bool(i1 ${e})`);
            }
            B.line(`call void @scr_dyn_arr_push(ptr ${d}, ptr ${boxed})`);
          } else {
            host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
            const e = B.tmp();
            B.line(`${e} = call ptr @scr_arr_get_ref(ptr %v, double ${i}) ; +1`);
            const conv = B.tmp();
            B.line(`${conv} = call ptr @${this.toDynHelper(elem)}(ptr ${e})`);
            B.line(`call void @scr_dyn_arr_push(ptr ${d}, ptr ${conv})`);
            B.line(`call void ${releaseSym(host, elem)}(ptr ${e})`);
          }
          B.terminate(`br label %${doneLabel}`);
          B.startBlock(doneLabel);
        });
        host.declare(`declare void @scr_arr_copy_metadata(ptr, ptr)`);
        B.line(`call void @scr_arr_copy_metadata(ptr %v, ptr ${d})`);
        if (cyclicArr) B.line(`call void @scr_dyn_from_leave()`);
        host.declare(`declare ptr @scr_dyn_mark_snapshot(ptr)`);
        B.line(`call ptr @scr_dyn_mark_snapshot(ptr ${d})`);
        B.terminate(`ret ptr ${d}`);
        break;
      }
      case "union": {
        const def = host.unionsById.get(t.unionId);
        if (!def)
          throw new InternalCompilerError(`llvm emitter bug: to-dyn of unknown union ${t.unionId}`);
        const nullable = host.nullableUnions.get(t.unionId);
        const tag = emitUnionTag(B, nullable, "%v");
        const bad = B.newLabel("tdu.bad");
        const labels = def.arms.map(() => B.newLabel("tdu.a"));
        B.terminate(
          `switch i32 ${tag}, label %${bad} [ ${def.arms.map((_, i) => `i32 ${i}, label %${labels[i]}`).join(" ")} ]`,
        );
        def.arms.forEach((arm, i) => {
          B.startBlock(labels[i]!);
          if (arm.kind === "undefinedT") {
            const u = this.undef(B);
            const r = this.retainDyn(B, u);
            B.terminate(`ret ptr ${r}`);
          } else if (arm.kind === "nullT") {
            host.declare(`declare ptr @scr_dyn_new_null()`);
            const r = B.tmp();
            B.line(`${r} = call ptr @scr_dyn_new_null()`);
            B.terminate(`ret ptr ${r}`);
          } else if (arm.kind === "f64" || arm.kind === "procStream") {
            host.declare(`declare double @scr_union_get_f64(ptr)`);
            const x = B.tmp();
            const r = B.tmp();
            B.line(`${x} = call double @scr_union_get_f64(ptr %v)`);
            B.line(`${r} = call ptr @${this.toDynHelper(arm)}(double ${x})`);
            B.terminate(`ret ptr ${r}`);
          } else if (arm.kind === "bool") {
            host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
            host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
            const x = B.tmp();
            const r = B.tmp();
            B.line(`${x} = call zeroext i1 @scr_union_get_bool(ptr %v)`);
            B.line(`${r} = call ptr @scr_dyn_new_bool(i1 ${x})`);
            B.terminate(`ret ptr ${r}`);
          } else if (arm.kind === "func") {
            // A boxable function arm crosses through the checked-dynamic
            // function boundary (the dynFrom func special case, sans name).
            const p = emitUnionPeek(B, nullable, "%v");
            const r = B.tmp();
            B.line(`${r} = call ptr @${this.dynFuncBoxHelper(arm)}(ptr ${p}, ptr null)`);
            B.terminate(`ret ptr ${r}`);
          } else {
            const p = emitUnionPeek(B, nullable, "%v");
            const r = B.tmp();
            B.line(`${r} = call ptr @${this.toDynHelper(arm)}(ptr ${p}) ; ${arm.kind}`);
            B.terminate(`ret ptr ${r}`);
          }
        });
        B.startBlock(bad);
        host.needBadTag();
        B.line(`call void @sc_bad_tag()`);
        B.terminate(`unreachable`);
        break;
      }
      case "promise": {
        // Promises box by REFERENCE (SCR_DYN_PROMISE — identity is the
        // promise): promise<dyn> carries its ScrPromise directly (the
        // payload is already a dyn value); any other inner boxes an
        // ADAPTER promise whose settle callback converts the payload
        // (rejections copy raw inside the runtime's cb-waiter machinery).
        if (t.inner.kind === "dyn") {
          host.declare(`declare ptr @scr_dyn_new_promise(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call ptr @scr_dyn_new_promise(ptr %v)`);
          B.terminate(`ret ptr ${r}`);
          break;
        }
        host.declare(`declare ptr @scr_dyn_new_promise_adapting(ptr, ptr)`);
        const adapter = this.promiseDynAdapterHelper(t.inner);
        const r = B.tmp();
        B.line(`${r} = call ptr @scr_dyn_new_promise_adapting(ptr %v, ptr @${adapter})`);
        B.terminate(`ret ptr ${r}`);
        break;
      }
      default: {
        // Runtime HANDLE kinds box by REFERENCE (identity — no copy):
        // scr_dyn_new_handle retains the borrowed operand through the
        // tag's installed ops.
        const h = DYN_HANDLE_KINDS.get(t.kind);
        if (h) {
          const box = DYN_HANDLE_BOX_FN[t.kind];
          const r = B.tmp();
          if (box) {
            host.declare(`declare ptr @${box}(ptr)`);
            B.line(`${r} = call ptr @${box}(ptr %v)`);
          } else {
            host.declare(`declare ptr @scr_dyn_new_handle(ptr, i32)`);
            B.line(
              `${r} = call ptr @scr_dyn_new_handle(ptr %v, i32 ${DYN_HANDLE_TAG_NUM[t.kind]})`,
            );
          }
          B.terminate(`ret ptr ${r}`);
          break;
        }
        throw new LlvmUnsupportedError(`type:${t.kind}`);
      }
    }
    this.defs.push(
      `define internal ptr @${name}(${this.valTy(t)} %v) ${FN_ATTRS} { ; to-dyn ${key}`,
      B.render(),
      `}`,
      ``,
    );
    if (sourceAccessor) {
      this.defs.push(
        `define internal ptr @${sourceAccessor.name}(ptr %v, i1 %materialize) ${FN_ATTRS} { ; record source ${key}`,
        `entry:`,
        `  br i1 %materialize, label %snapshot, label %release`,
        `snapshot:`,
        `  %d = call ptr @${name}(ptr %v)`,
        `  ret ptr %d`,
        `release:`,
        `  call void ${sourceAccessor.release}(ptr %v)`,
        `  ret ptr null`,
        `}`,
        ``,
      );
    }
    this.host.journalBuilt?.();
    return name;
  }

  /** The checked-dynamic tree-promise settle adapter for one fulfillment payload type —
   * promiseDynAdapterHelper (walkers.ts), ported:
   * `void sc_pda_<n>(ptr %dst, ptr %src)` reads src's fulfilled payload
   * by its compile-time kind, converts it to a dyn value, and fulfills
   * dst with it (scr_dyn_new_promise_adapting's callback; rejections
   * never reach an adapter — the runtime copies them raw). Interned per
   * inner typeKey. */
  private promiseDynAdapterHelper(inner: IrType): string {
    const key = typeKey(inner);
    const existing = this.promiseDynAdapters.get(key);
    if (existing) return existing;
    const name = `sc_pda_${this.promiseDynAdapters.size}`;
    this.promiseDynAdapters.set(key, name);
    this.host.journalAllocated?.(name, "dyn.promiseDynAdapterHelper", [inner]);
    const host = this.host;
    const B = new BlockBuilder();
    host.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    host.declare(`declare void @scr_dyn_trace_v(ptr, ptr, ptr)`);
    host.declare(`declare void @scr_dyn_release_v(ptr)`);
    const fulfill = (dv: string): void => {
      B.line(
        `call void @scr_promise_fulfill_ref(ptr %dst, ptr ${dv}, ptr @scr_dyn_retain_v, ptr @scr_dyn_release_v, ptr @scr_dyn_trace_v)`,
      );
    };
    switch (inner.kind) {
      case "void":
      case "undefinedT": {
        const u = this.undef(B);
        fulfill(this.retainDyn(B, u));
        break;
      }
      case "nullT": {
        host.declare(`declare ptr @scr_dyn_new_null()`);
        const dv = B.tmp();
        B.line(`${dv} = call ptr @scr_dyn_new_null()`);
        fulfill(dv);
        break;
      }
      case "procStream":
      case "f64": {
        host.declare(`declare double @scr_promise_payload_f64(ptr)`);
        const x = B.tmp();
        const dv = B.tmp();
        B.line(`${x} = call double @scr_promise_payload_f64(ptr %src)`);
        B.line(`${dv} = call ptr @${this.toDynHelper(inner)}(double ${x})`);
        fulfill(dv);
        break;
      }
      case "bool": {
        host.declare(`declare zeroext i1 @scr_promise_payload_bool(ptr)`);
        host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
        const x = B.tmp();
        const dv = B.tmp();
        B.line(`${x} = call zeroext i1 @scr_promise_payload_bool(ptr %src)`);
        B.line(`${dv} = call ptr @scr_dyn_new_bool(i1 ${x})`);
        fulfill(dv);
        break;
      }
      case "string": {
        host.declare(`declare ptr @scr_promise_payload_str(ptr)`);
        host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
        host.declare(`declare void @scr_str_release(ptr)`);
        const s = B.tmp();
        const dv = B.tmp();
        B.line(`${s} = call ptr @scr_promise_payload_str(ptr %src) ; +1`);
        B.line(`${dv} = call ptr @scr_dyn_new_str(ptr ${s}) ; retains s`);
        B.line(`call void @scr_str_release(ptr ${s})`);
        fulfill(dv);
        break;
      }
      default: {
        // Ref-payload inners (records, arrays, bytes, %Error, unions,
        // nested promises, handles): extract (+1 via the stored retain),
        // convert through the shared to-dyn spelling, release the extract.
        host.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
        const pv = B.tmp();
        B.line(`${pv} = call ptr @scr_promise_payload_ref(ptr %src) ; +1`);
        const dv = this.toDynExpr(B, inner, pv);
        if (isRefCounted(inner)) B.line(`call void ${releaseSym(host, inner)}(ptr ${pv})`);
        fulfill(dv);
        break;
      }
    }
    B.terminate(`ret void`);
    this.defs.push(
      `define internal void @${name}(ptr %dst, ptr %src) ${FN_ATTRS} { ; dyn-box settle adapter for promise<${key}>`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── the dyn ToString pair (dynToStrHelper, ported) ────────────────── */

  /** Node's String() over a dyn value — sc_ds (+1 result) over the
   * recursive sc_ds_buf walker. Borrowed operand; an exception that an
   * object's toString or valueOf throws stays pending. */
  dynToStrHelper(): string {
    if (this.dynToStrFn) return this.dynToStrFn;
    const name = "sc_ds";
    this.dynToStrFn = name;
    this.host.journalAllocated?.(name, "dyn.dynToStrHelper", []);
    const host = this.host;
    host.declare(`declare void @scr_jb_init(ptr)`);
    host.declare(`declare ptr @scr_jb_finish(ptr)`);
    host.declare(`declare void @scr_jb_putc(ptr, i8)`);
    host.declare(`declare void @scr_jb_puts(ptr, ptr)`);
    host.declare(`declare void @scr_str_release(ptr)`);

    // The recursive buffer walker.
    {
      const B = new BlockBuilder();
      const kd = this.kindOf(B, "%d");
      const done = B.newLabel("ds.d");
      const labels = new Map<number, string>();
      for (const k of [
        DYN_KIND.NULL,
        DYN_KIND.BOOL,
        DYN_KIND.NUM,
        DYN_KIND.STR,
        DYN_KIND.ARR,
        DYN_KIND.OBJ,
        DYN_KIND.UNDEF,
        DYN_KIND.BYTES,
        DYN_KIND.FUNC,
        DYN_KIND.HANDLE,
        DYN_KIND.PROMISE,
        DYN_KIND.TYPED_REF,
        DYN_KIND.PROXY,
        DYN_KIND.BIGINT,
        DYN_KIND.SYMBOL,
      ]) {
        labels.set(k, B.newLabel(`ds.k${k}`));
      }
      const branches: string[] = [];
      for (const [kind, label] of labels) branches.push(`i32 ${kind}, label %${label}`);
      B.terminate(`switch i32 ${kd}, label %${done} [ ${branches.join(" ")} ]`);
      B.startBlock(labels.get(DYN_KIND.PROXY)!);
      host.declare(`declare void @scr_dyn_proxy_unsupported(ptr)`);
      B.line(`call void @scr_dyn_proxy_unsupported(ptr ${host.cstr("string conversion")})`);
      B.br(done);
      B.startBlock(labels.get(DYN_KIND.TYPED_REF)!);
      {
        host.declare(`declare ptr @scr_dyn_typed_ref_string_view(ptr)`);
        host.declare(`declare void @scr_dyn_release_v(ptr)`);
        const materialized = B.tmp();
        B.line(`${materialized} = call ptr @scr_dyn_typed_ref_string_view(ptr %d)`);
        B.line(`call void @sc_ds_buf(ptr %b, ptr ${materialized})`);
        B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.UNDEF)!);
      this.puts(B, "%b", "undefined");
      B.br(done);
      B.startBlock(labels.get(DYN_KIND.NULL)!);
      this.puts(B, "%b", "null");
      B.br(done);
      B.startBlock(labels.get(DYN_KIND.BOOL)!);
      {
        const bv = this.boolOf(B, "%d");
        const s = B.tmp();
        B.line(`${s} = select i1 ${bv}, ptr ${host.cstr("true")}, ptr ${host.cstr("false")}`);
        B.line(`call void @scr_jb_puts(ptr %b, ptr ${s})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.BIGINT)!);
      {
        host.declare(`declare ptr @scr_bigint_to_string(ptr, double)`);
        const v = this.payloadOf(B, "%d", "ptr");
        const s = B.tmp();
        B.line(`${s} = call ptr @scr_bigint_to_string(ptr ${v}, double ${f64Lit(10)})`);
        this.putScrStr(B, "%b", s);
        B.line(`call void @scr_str_release(ptr ${s})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.SYMBOL)!);
      {
        host.declare(`declare ptr @scr_dyn_string_coerce(ptr)`);
        const s = B.tmp();
        B.line(`${s} = call ptr @scr_dyn_string_coerce(ptr %d)`);
        B.line(`call void @scr_str_release(ptr ${s})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.NUM)!);
      {
        // String(n): NaN/Infinity spelled out, not the JSON null.
        const x = this.payloadOf(B, "%d", "double");
        host.declare(`declare void @scr_jb_put_number(ptr, double)`);
        B.line(`call void @scr_jb_put_number(ptr %b, double ${x})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.STR)!);
      {
        const s = this.payloadOf(B, "%d", "ptr");
        this.putScrStr(B, "%b", s);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.ARR)!);
      {
        // Array.prototype.toString: join(",") — null/undefined ELEMENTS
        // print empty (unlike top level), nested arrays flatten. The length
        // is read once, as join reads it.
        const n = this.lenOf(B, "%d");
        this.i64Loop(B, "ds.ar", n, (i, brNext) => {
          const nz = B.tmp();
          B.line(`${nz} = icmp ugt ${this.S} ${i}, 0`);
          const lcm = B.newLabel("ds.cm");
          const lel = B.newLabel("ds.el");
          B.condBr(nz, lcm, lel);
          B.startBlock(lcm);
          B.line(`call void @scr_jb_putc(ptr %b, i8 44)`);
          B.br(lel);
          B.startBlock(lel);
          // Each index reads the element as join does (scr_dyn_arr_at, +1):
          // from the current storage, undefined past the current length,
          // and through the prototype for a hole. An element's toString
          // can append to, shrink or reallocate the array; a getter that
          // throws answers NULL with the exception pending.
          host.declare(`declare ptr @scr_dyn_arr_at(ptr, double)`);
          host.declare(`declare void @scr_dyn_release_v(ptr)`);
          const index = B.tmp();
          B.line(`${index} = uitofp ${this.S} ${i} to double`);
          const e = B.tmp();
          B.line(`${e} = call ptr @scr_dyn_arr_at(ptr %d, double ${index})`);
          const missing = B.tmp();
          B.line(`${missing} = icmp eq ptr ${e}, null`);
          const lGot = B.newLabel("ds.gt");
          B.condBr(missing, done, lGot);
          B.startBlock(lGot);
          const ek = this.kindOf(B, e);
          const isU = B.tmp();
          const isN = B.tmp();
          const unit = B.tmp();
          B.line(`${isU} = icmp eq i32 ${ek}, ${DYN_KIND.UNDEF}`);
          B.line(`${isN} = icmp eq i32 ${ek}, ${DYN_KIND.NULL}`);
          B.line(`${unit} = or i1 ${isU}, ${isN}`);
          const lRec = B.newLabel("ds.rc");
          const lSkip = B.newLabel("ds.sk");
          B.condBr(unit, lSkip, lRec);
          B.startBlock(lSkip);
          B.line(`call void @scr_dyn_release_v(ptr ${e})`);
          brNext();
          B.startBlock(lRec);
          B.line(`call void @sc_ds_buf(ptr %b, ptr ${e})`);
          B.line(`call void @scr_dyn_release_v(ptr ${e})`);
          // The first exception an element's conversion throws ends the
          // conversion; later elements are not read.
          const thrown = B.tmp();
          for (const line of host.pendingTestLines(thrown)) B.line(line.trimStart());
          const lMore = B.newLabel("ds.mo");
          B.condBr(thrown, done, lMore);
          B.startBlock(lMore);
        });
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.OBJ)!);
      {
        // The checked-dynamic tree's error encoding renders Error.prototype.toString;
        // other objects convert with ToPrimitive's string hint: a toString or
        // valueOf of their own or of their prototypes, else "[object Object]".
        const marker = this.objGetLit(B, "%d", "%error");
        const isErr = B.tmp();
        B.line(`${isErr} = icmp ne ptr ${marker}, null`);
        const lErr = B.newLabel("ds.er");
        const lPlain = B.newLabel("ds.pl");
        B.condBr(isErr, lErr, lPlain);
        B.startBlock(lPlain);
        {
          // Null leaves the exception the conversion threw pending.
          host.declare(`declare ptr @scr_dyn_string_coerce_js(ptr)`);
          host.declare(`declare void @scr_str_release(ptr)`);
          const text = B.tmp();
          B.line(`${text} = call ptr @scr_dyn_string_coerce_js(ptr %d)`);
          const converted = B.tmp();
          B.line(`${converted} = icmp ne ptr ${text}, null`);
          const lPut = B.newLabel("ds.pp");
          B.condBr(converted, lPut, done);
          B.startBlock(lPut);
          this.putScrStr(B, "%b", text);
          B.line(`call void @scr_str_release(ptr ${text})`);
          B.br(done);
        }
        B.startBlock(lErr);
        // Error.prototype.toString, reading name and message through the
        // prototype. Null leaves the exception its conversion threw pending.
        host.declare(`declare ptr @scr_dyn_error_string(ptr)`);
        host.declare(`declare void @scr_str_release(ptr)`);
        const text = B.tmp();
        B.line(`${text} = call ptr @scr_dyn_error_string(ptr %d)`);
        const written = B.tmp();
        B.line(`${written} = icmp ne ptr ${text}, null`);
        const lPut = B.newLabel("ds.ep");
        B.condBr(written, lPut, done);
        B.startBlock(lPut);
        this.putScrStr(B, "%b", text);
        B.line(`call void @scr_str_release(ptr ${text})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.BYTES)!);
      {
        // Buffer-flavored values coerce utf8; typed arrays join their
        // elements and a DataView answers "[object DataView]" (the
        // runtime's conversion).
        const bufp = B.tmp();
        const bufRaw = B.tmp();
        const isBuf = B.tmp();
        B.line(
          `${bufp} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(12, 8)} ; ->buffer`,
        );
        B.line(`${bufRaw} = load i8, ptr ${bufp}`);
        B.line(`${isBuf} = icmp ne i8 ${bufRaw}, 0`);
        const lBuf = B.newLabel("ds.bu");
        const lJoin = B.newLabel("ds.bj");
        B.condBr(isBuf, lBuf, lJoin);
        B.startBlock(lBuf);
        host.declare(`declare ptr @scr_bytes_to_str(ptr, ptr)`);
        const bytes = this.payloadOf(B, "%d", "ptr");
        const enc = host.internLiteral("utf8");
        const txt = B.tmp();
        B.line(`${txt} = call ptr @scr_bytes_to_str(ptr ${bytes}, ptr ${enc})`);
        this.putScrStr(B, "%b", txt);
        B.line(`call void @scr_str_release(ptr ${txt})`);
        B.br(done);
        B.startBlock(lJoin);
        host.declare(`declare ptr @scr_dyn_to_string(ptr, ptr)`);
        const joined = B.tmp();
        B.line(`${joined} = call ptr @scr_dyn_to_string(ptr %d, ptr null)`);
        this.putScrStr(B, "%b", joined);
        B.line(`call void @scr_str_release(ptr ${joined})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.FUNC)!);
      {
        // Function.prototype.toString: the native-code form.
        this.puts(B, "%b", "function ");
        const namep = B.tmp();
        const nm = B.tmp();
        B.line(
          `${namep} = getelementptr inbounds i8, ptr %d, i64 ${this.abiOffset(40, 28)} ; ->v.fn.name`,
        );
        B.line(`${nm} = load ptr, ptr ${namep}`);
        const nn = B.tmp();
        B.line(`${nn} = icmp ne ptr ${nm}, null`);
        const lt = B.newLabel("ds.fn");
        const lj = B.newLabel("ds.fj");
        B.condBr(nn, lt, lj);
        B.startBlock(lt);
        B.line(`call void @scr_jb_puts(ptr %b, ptr ${nm})`);
        B.br(lj);
        B.startBlock(lj);
        this.puts(B, "%b", "() { [native code] }");
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.HANDLE)!);
      {
        host.declare(`declare ptr @scr_dyn_to_string(ptr, ptr)`);
        const s = B.tmp();
        B.line(`${s} = call ptr @scr_dyn_to_string(ptr %d, ptr null)`);
        this.putScrStr(B, "%b", s);
        B.line(`call void @scr_str_release(ptr ${s})`);
        B.br(done);
      }
      B.startBlock(labels.get(DYN_KIND.PROMISE)!);
      // Object.prototype.toString with the Promise @@toStringTag.
      this.puts(B, "%b", "[object Promise]");
      B.br(done);
      B.startBlock(done);
      B.terminate(`ret void`);
      this.defs.push(
        `define internal void @${name}_buf(ptr %b, ptr %d) ${FN_ATTRS} { ; String(unknown), recursive`,
        B.render(),
        `}`,
        ``,
      );
    }

    // The +1 wrapper with the string fast path.
    {
      const B = new BlockBuilder();
      const kd = this.kindOf(B, "%d");
      const isStr = B.tmp();
      B.line(`${isStr} = icmp eq i32 ${kd}, ${DYN_KIND.STR}`);
      const lFast = B.newLabel("ds.f");
      const lSlow = B.newLabel("ds.s");
      B.condBr(isStr, lFast, lSlow);
      B.startBlock(lFast);
      host.declare(`declare ptr @scr_str_retain_v(ptr)`);
      const s = this.payloadOf(B, "%d", "ptr");
      const r = B.tmp();
      B.line(`${r} = call ptr @scr_str_retain_v(ptr ${s})`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lSlow);
      const buf = "%dsb";
      B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
      B.line(`call void @scr_jb_init(ptr ${buf})`);
      B.line(`call void @${name}_buf(ptr ${buf}, ptr %d)`);
      const out = B.tmp();
      B.line(`${out} = call ptr @scr_jb_finish(ptr ${buf})`);
      B.terminate(`ret ptr ${out}`);
      this.defs.push(
        `define internal ptr @${name}(ptr %d) ${FN_ATTRS} { ; String(unknown) -> owned (+1)`,
        B.render(),
        `}`,
        ``,
      );
    }
    this.host.journalBuilt?.();
    return name;
  }

  /* ── caughtToDyn (walkers.ts, ported) ─────────────────────────── */

  /** A catch binding flowing into an `unknown` slot: the typed→unknown
   * deep-copy stance over the exception snapshot's runtime kind. */
  caughtToDynHelper(): string {
    if (this.caughtToDynFn) return this.caughtToDynFn;
    const name = "sc_cd";
    this.caughtToDynFn = name;
    this.host.journalAllocated?.(name, "dyn.caughtToDynHelper", []);
    const host = this.host;
    const B = new BlockBuilder();
    const kp = B.tmp();
    const kd = B.tmp();
    B.line(`${kp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 1`);
    B.line(`${kd} = load i32, ptr ${kp}`);
    const lF64 = B.newLabel("cd.f");
    const lBool = B.newLabel("cd.b");
    const lStr = B.newLabel("cd.s");
    const lObj = B.newLabel("cd.o");
    const lDef = B.newLabel("cd.d");
    // SCR_EXC_F64=1, BOOL=2, STR=3, REF=4 (default), OBJ=5.
    B.terminate(
      `switch i32 ${kd}, label %${lDef} [ i32 1, label %${lF64} i32 2, label %${lBool} i32 3, label %${lStr} i32 5, label %${lObj} ]`,
    );
    B.startBlock(lF64);
    host.declare(`declare ptr @scr_dyn_new_num(double)`);
    {
      const xp = B.tmp();
      const x = B.tmp();
      const r = B.tmp();
      B.line(`${xp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 2`);
      B.line(`${x} = load double, ptr ${xp}`);
      B.line(`${r} = call ptr @scr_dyn_new_num(double ${x})`);
      B.terminate(`ret ptr ${r}`);
    }
    B.startBlock(lBool);
    host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
    {
      const xp = B.tmp();
      const raw = B.tmp();
      const x = B.tmp();
      const r = B.tmp();
      B.line(`${xp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 3`);
      B.line(`${raw} = load i8, ptr ${xp}`);
      B.line(`${x} = trunc i8 ${raw} to i1`);
      B.line(`${r} = call ptr @scr_dyn_new_bool(i1 ${x})`);
      B.terminate(`ret ptr ${r}`);
    }
    B.startBlock(lStr);
    host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
    {
      const pp = B.tmp();
      const p = B.tmp();
      const r = B.tmp();
      B.line(`${pp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 4`);
      B.line(`${p} = load ptr, ptr ${pp}`);
      B.line(`${r} = call ptr @scr_dyn_new_str(ptr ${p}) ; _new_str retains`);
      B.terminate(`ret ptr ${r}`);
    }
    B.startBlock(lObj);
    host.declare(`declare zeroext i1 @scr_error_is(ptr)`);
    {
      const pp = B.tmp();
      const p = B.tmp();
      B.line(`${pp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 4`);
      B.line(`${p} = load ptr, ptr ${pp}`);
      const isErr = B.tmp();
      B.line(`${isErr} = call zeroext i1 @scr_error_is(ptr ${p})`);
      const lErr = B.newLabel("cd.e");
      B.condBr(isErr, lErr, lDef);
      B.startBlock(lErr);
      // The identity-cached crossing (scr_json.c): one error instance,
      // one dyn node — the C walker's arm exactly.
      host.declare(`declare ptr @scr_dyn_from_error(ptr)`);
      const r = B.tmp();
      B.line(`${r} = call ptr @scr_dyn_from_error(ptr ${p})`);
      B.terminate(`ret ptr ${r}`);
    }
    B.startBlock(lDef);
    // SCR_EXC_REF: a thrown dyn value passes back BY REFERENCE (identity
    // with every other holder — the dyn adapters discriminate); non-dyn
    // REF and non-Error objects keep the "[object Object]" approximation
    // — truthy, typeof "object", fields unreadable.
    host.declare(`declare ptr @scr_dyn_new_obj()`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    {
      const rfp = B.tmp();
      const rf = B.tmp();
      B.line(`${rfp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 5`);
      B.line(`${rf} = load ptr, ptr ${rfp}`);
      const isDyn = B.tmp();
      B.line(`${isDyn} = icmp eq ptr ${rf}, @scr_dyn_retain_v`);
      const lRef = B.newLabel("cd.r");
      const lPlain = B.newLabel("cd.p");
      B.condBr(isDyn, lRef, lPlain);
      B.startBlock(lRef);
      const pp = B.tmp();
      const p = B.tmp();
      const r = B.tmp();
      B.line(`${pp} = getelementptr inbounds %ScrCaught, ptr %c, i64 0, i32 4`);
      B.line(`${p} = load ptr, ptr ${pp}`);
      B.line(`${r} = call ptr @scr_dyn_retain_v(ptr ${p})`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lPlain);
      const e = B.tmp();
      B.line(`${e} = call ptr @scr_dyn_new_obj()`);
      B.terminate(`ret ptr ${e}`);
    }
    this.defs.push(
      `define internal ptr @${name}(ptr %c) ${FN_ATTRS} { ; caught -> unknown (+1, fresh tree)`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── the keyed read (dynKeyGetHelper, ported) ──────────────────────── */

  /** `sc_dyn_key_get(ptr d, ptr k, i1 opt) -> ptr` — d[k] on a dyn value.
   * Result +1; throws on non-optional nullish receivers. */
  dynComputedKeyGetHelper(): string {
    const name = "sc_dyn_computed_key_get";
    if (this.helperMemo.has(name)) return name;
    this.helperMemo.set(name, name);
    const B = new BlockBuilder();
    const host = this.host;
    this.host.journalAllocated?.(name, "dyn.dynComputedKeyGetHelper", []);
    const stringHelper = this.dynKeyGetHelper();
    host.declare(`declare ptr @scr_dyn_property_key_value(ptr)`);
    host.declare(`declare ptr @scr_dyn_symbol_key_get(ptr, ptr, i1 zeroext)`);
    host.declare(`declare void @scr_dyn_release(ptr)`);
    const key = B.tmp();
    B.line(`${key} = call ptr @scr_dyn_property_key_value(ptr %key)`);
    const missing = B.tmp();
    B.line(`${missing} = icmp eq ptr ${key}, null`);
    const fail = B.newLabel("kg.fail");
    const dispatch = B.newLabel("kg.dispatch");
    B.condBr(missing, fail, dispatch);
    B.startBlock(fail);
    B.terminate("ret ptr null");
    B.startBlock(dispatch);
    const kind = this.kindOf(B, key);
    const symbol = B.tmp();
    B.line(`${symbol} = icmp eq i32 ${kind}, ${DYN_KIND.SYMBOL}`);
    const sym = B.newLabel("kg.symbol");
    const str = B.newLabel("kg.string");
    B.condBr(symbol, sym, str);
    B.startBlock(sym);
    const sv = B.tmp();
    B.line(`${sv} = call ptr @scr_dyn_symbol_key_get(ptr %d, ptr ${key}, i1 %opt)`);
    B.line(`call void @scr_dyn_release(ptr ${key})`);
    B.terminate(`ret ptr ${sv}`);
    B.startBlock(str);
    const text = this.payloadOf(B, key, "ptr");
    const value = B.tmp();
    B.line(`${value} = call ptr @${stringHelper}(ptr %d, ptr ${text}, i1 %opt)`);
    // A key naming an Object.prototype member answers the inherited member
    // in place of an undefined read, as a constant key does.
    host.declare(`declare ptr @scr_dyn_inherited_read(ptr, ptr, ptr)`);
    const inherited = B.tmp();
    B.line(`${inherited} = call ptr @scr_dyn_inherited_read(ptr %d, ptr ${text}, ptr ${value})`);
    B.line(`call void @scr_dyn_release(ptr ${key})`);
    B.terminate(`ret ptr ${inherited}`);
    this.defs.push(
      `define internal ptr @${name}(ptr %d, ptr %key, i1 zeroext %opt) ${FN_ATTRS} {`,
      B.render(),
      "}",
      "",
    );
    this.host.journalBuilt?.();
    return name;
  }

  dynKeyGetHelper(): string {
    const memoKey = "%dynKeyGet";
    const existing = this.dynBuilders.get(memoKey);
    if (existing) return existing;
    const name = "sc_dyn_key_get";
    this.dynBuilders.set(memoKey, name);
    this.host.journalAllocated?.(name, "dyn.dynKeyGetHelper", []);
    const host = this.host;
    const B = new BlockBuilder();
    const kd = this.kindOf(B, "%d");
    const kParts = this.strParts(B, "%k");
    const retainUndef = (): void => {
      const u = this.undef(B);
      const r = this.retainDyn(B, u);
      B.terminate(`ret ptr ${r}`);
    };
    // undefined/null receivers: opt answers undefined; otherwise throw
    // Node's TypeError with the key spliced in.
    {
      const isU = B.tmp();
      const isN = B.tmp();
      const unit = B.tmp();
      B.line(`${isU} = icmp eq i32 ${kd}, ${DYN_KIND.UNDEF}`);
      B.line(`${isN} = icmp eq i32 ${kd}, ${DYN_KIND.NULL}`);
      B.line(`${unit} = or i1 ${isU}, ${isN}`);
      const lUnit = B.newLabel("kg.u");
      const lNext = B.newLabel("kg.n");
      B.condBr(unit, lUnit, lNext);
      B.startBlock(lUnit);
      const lOpt = B.newLabel("kg.o");
      const lThrow = B.newLabel("kg.t");
      B.condBr("%opt", lOpt, lThrow);
      B.startBlock(lOpt);
      retainUndef();
      B.startBlock(lThrow);
      host.declare(`declare ptr @scr_str_new(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
      host.declare(`declare void @scr_str_release(ptr)`);
      host.declare(`declare void @scr_throw_error(i32, ptr)`);
      const baseU = "Cannot read properties of undefined (reading '";
      const baseN = "Cannot read properties of null (reading '";
      const base = B.tmp();
      B.line(`${base} = select i1 ${isU}, ptr ${host.cstr(baseU)}, ptr ${host.cstr(baseN)}`);
      const baseLen = B.tmp();
      B.line(
        `${baseLen} = select i1 ${isU}, ${host.sizeType} ${Buffer.byteLength(baseU)}, ${host.sizeType} ${Buffer.byteLength(baseN)}`,
      );
      const head = B.tmp();
      B.line(`${head} = call ptr @scr_str_new(ptr ${base}, ${host.sizeType} ${baseLen})`);
      const withKey = B.tmp();
      B.line(`${withKey} = call ptr @scr_str_concat(ptr ${head}, ptr %k)`);
      B.line(`call void @scr_str_release(ptr ${head})`);
      const tail = B.tmp();
      B.line(`${tail} = call ptr @scr_str_new(ptr ${host.cstr("')")}, ${host.sizeType} 2)`);
      const msg = B.tmp();
      B.line(`${msg} = call ptr @scr_str_concat(ptr ${withKey}, ptr ${tail})`);
      B.line(`call void @scr_str_release(ptr ${withKey})`);
      B.line(`call void @scr_str_release(ptr ${tail})`);
      B.line(`call void @scr_throw_error(i32 1, ptr ${msg}) ; SCR_ERR_TYPE; takes ownership`);
      B.terminate(`ret ptr null`);
      B.startBlock(lNext);
    }
    {
      const isSymbol = B.tmp();
      B.line(`${isSymbol} = icmp eq i32 ${kd}, ${DYN_KIND.SYMBOL}`);
      const lSymbol = B.newLabel("kg.sym");
      const lNext = B.newLabel("kg.n");
      B.condBr(isSymbol, lSymbol, lNext);
      B.startBlock(lSymbol);
      host.declare(`declare ptr @scr_dyn_symbol_get(ptr, ptr)`);
      const r = B.tmp();
      B.line(`${r} = call ptr @scr_dyn_symbol_get(ptr %d, ptr %k)`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lNext);
    }
    // Typed stream capsules expose their one cached, refreshed dyn view to
    // ordinary property reads while the capsule itself keeps identity.
    {
      const isTyped = B.tmp();
      B.line(`${isTyped} = icmp eq i32 ${kd}, ${DYN_KIND.TYPED_REF}`);
      const lTyped = B.newLabel("kg.tr");
      const lNext = B.newLabel("kg.n");
      B.condBr(isTyped, lTyped, lNext);
      B.startBlock(lTyped);
      // Live arrays answer `length` and own elements from the native array;
      // rebuilding the snapshot per read would make index loops quadratic.
      host.declare(`declare ptr @scr_dyn_typed_ref_key_get(ptr, ptr)`);
      const fast = B.tmp();
      const hit = B.tmp();
      B.line(`${fast} = call ptr @scr_dyn_typed_ref_key_get(ptr %d, ptr %k)`);
      B.line(`${hit} = icmp ne ptr ${fast}, null`);
      const lFast = B.newLabel("kg.tr.fast");
      const lView = B.newLabel("kg.tr.view");
      B.condBr(hit, lFast, lView);
      B.startBlock(lFast);
      B.terminate(`ret ptr ${fast}`);
      B.startBlock(lView);
      host.declare(`declare ptr @scr_dyn_typed_ref_materialize(ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      const materialized = B.tmp();
      const r = B.tmp();
      B.line(`${materialized} = call ptr @scr_dyn_typed_ref_materialize(ptr %d)`);
      B.line(`${r} = call ptr @${name}(ptr ${materialized}, ptr %k, i1 %opt)`);
      B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lNext);
    }

    {
      const isProxy = B.tmp();
      B.line(`${isProxy} = icmp eq i32 ${kd}, ${DYN_KIND.PROXY}`);
      const lProxy = B.newLabel("kg.proxy");
      const lNext = B.newLabel("kg.n");
      B.condBr(isProxy, lProxy, lNext);
      B.startBlock(lProxy);
      host.declare(`declare ptr @scr_dyn_proxy_get(ptr, ptr)`);
      const r = B.tmp();
      B.line(`${r} = call ptr @scr_dyn_proxy_get(ptr %d, ptr %k)`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lNext);
    }

    // OBJ: the own member or the inherited builtin Error constructor.
    {
      const isObj = B.tmp();
      B.line(`${isObj} = icmp eq i32 ${kd}, ${DYN_KIND.OBJ}`);
      const lObj = B.newLabel("kg.ob");
      const lNext = B.newLabel("kg.n");
      B.condBr(isObj, lObj, lNext);
      B.startBlock(lObj);
      host.declare(`declare ptr @scr_dyn_obj_read(ptr, ptr, ${host.sizeType})`);
      const r = B.tmp();
      B.line(
        `${r} = call ptr @scr_dyn_obj_read(ptr %d, ptr ${kParts.data}, ${host.sizeType} ${kParts.len})`,
      );
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lNext);
    }
    // HANDLE: the tag's modeled properties through the installed ops.
    {
      const isH = B.tmp();
      B.line(`${isH} = icmp eq i32 ${kd}, ${DYN_KIND.HANDLE}`);
      const lH = B.newLabel("kg.h");
      const lNext = B.newLabel("kg.n");
      B.condBr(isH, lH, lNext);
      B.startBlock(lH);
      host.declare(`declare ptr @scr_dyn_handle_key_get(ptr, ptr)`);
      const r = B.tmp();
      B.line(`${r} = call ptr @scr_dyn_handle_key_get(ptr %d, ptr %k)`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lNext);
    }
    // PROMISE: Promise.prototype.then/catch/finally as function values;
    // every other key is undefined (promises have no own properties).
    {
      const isP = B.tmp();
      B.line(`${isP} = icmp eq i32 ${kd}, ${DYN_KIND.PROMISE}`);
      const lP = B.newLabel("kg.p");
      const lNext = B.newLabel("kg.n");
      B.condBr(isP, lP, lNext);
      B.startBlock(lP);
      host.declare(`declare ptr @scr_dyn_promise_key_get(ptr, ptr)`);
      const r = B.tmp();
      B.line(`${r} = call ptr @scr_dyn_promise_key_get(ptr %d, ptr %k)`);
      B.terminate(`ret ptr ${r}`);
      B.startBlock(lNext);
    }
    // The canonical-index parse, shared by BYTES/ARR/STR: digits only,
    // no leading zero. Leaves (digits, idx).
    const parseIndex = (): { digits: string; idx: string } => {
      const digitsSlot = B.slot();
      const idxSlot = B.slot();
      B.entryAllocas.push(`${digitsSlot} = alloca i1`, `${idxSlot} = alloca ${host.sizeType}`);
      B.line(`store i1 false, ptr ${digitsSlot}`);
      B.line(`store ${host.sizeType} 0, ptr ${idxSlot}`);
      // k->len > 0 && !(k->len > 1 && k->data[0] == '0')
      const nz = B.tmp();
      B.line(`${nz} = icmp ugt ${host.sizeType} ${kParts.len}, 0`);
      const lGo = B.newLabel("kg.ix");
      const lOut = B.newLabel("kg.io");
      B.condBr(nz, lGo, lOut);
      B.startBlock(lGo);
      const multi = B.tmp();
      B.line(`${multi} = icmp ugt ${host.sizeType} ${kParts.len}, 1`);
      const c0 = B.tmp();
      B.line(`${c0} = load i8, ptr ${kParts.data}`);
      const isZero = B.tmp();
      B.line(`${isZero} = icmp eq i8 ${c0}, 48`);
      const leading = B.tmp();
      B.line(`${leading} = and i1 ${multi}, ${isZero}`);
      const lParse = B.newLabel("kg.ip");
      B.condBr(leading, lOut, lParse);
      B.startBlock(lParse);
      B.line(`store i1 true, ptr ${digitsSlot}`);
      this.i64Loop(B, "kg.id", kParts.len, (i) => {
        const cp = B.tmp();
        const c = B.tmp();
        B.line(`${cp} = getelementptr inbounds i8, ptr ${kParts.data}, ${host.sizeType} ${i}`);
        B.line(`${c} = load i8, ptr ${cp}`);
        const lt0 = B.tmp();
        const gt9 = B.tmp();
        B.line(`${lt0} = icmp ult i8 ${c}, 48`);
        B.line(`${gt9} = icmp ugt i8 ${c}, 57`);
        const cur = B.tmp();
        B.line(`${cur} = load ${host.sizeType}, ptr ${idxSlot}`);
        const over = B.tmp();
        B.line(`${over} = icmp ugt ${host.sizeType} ${cur}, ${this.indexMaxDiv10}`);
        const bad0 = B.tmp();
        const bad = B.tmp();
        B.line(`${bad0} = or i1 ${lt0}, ${gt9}`);
        B.line(`${bad} = or i1 ${bad0}, ${over}`);
        const lBad = B.newLabel("kg.ib");
        const lStep = B.newLabel("kg.is");
        B.condBr(bad, lBad, lStep);
        B.startBlock(lBad);
        B.line(`store i1 false, ptr ${digitsSlot}`);
        B.br(lOut);
        B.startBlock(lStep);
        const ten = B.tmp();
        const digit = B.tmp();
        const digitSize = B.tmp();
        const nx = B.tmp();
        B.line(`${ten} = mul ${host.sizeType} ${cur}, 10`);
        B.line(`${digit} = sub i8 ${c}, 48`);
        B.line(`${digitSize} = zext i8 ${digit} to ${host.sizeType}`);
        B.line(`${nx} = add ${host.sizeType} ${ten}, ${digitSize}`);
        B.line(`store ${host.sizeType} ${nx}, ptr ${idxSlot}`);
      });
      B.br(lOut);
      B.startBlock(lOut);
      const digits = B.tmp();
      const idx = B.tmp();
      B.line(`${digits} = load i1, ptr ${digitsSlot}`);
      B.line(`${idx} = load ${host.sizeType}, ptr ${idxSlot}`);
      return { digits, idx };
    };
    const isLength = (): string => {
      host.declare(`declare i32 @memcmp(ptr, ptr, ${host.sizeType})`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      B.line(`store i1 false, ptr ${slot}`);
      const len6 = B.tmp();
      B.line(`${len6} = icmp eq ${host.sizeType} ${kParts.len}, 6`);
      const lCmp = B.newLabel("kg.l6");
      const lj = B.newLabel("kg.lj");
      B.condBr(len6, lCmp, lj);
      B.startBlock(lCmp);
      const c = B.tmp();
      const same = B.tmp();
      B.line(
        `${c} = call i32 @memcmp(ptr ${kParts.data}, ptr ${host.cstr("length")}, ${host.sizeType} 6)`,
      );
      B.line(`${same} = icmp eq i32 ${c}, 0`);
      B.line(`store i1 ${same}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const out = B.tmp();
      B.line(`${out} = load i1, ptr ${slot}`);
      return out;
    };
    // Parse once up front (pure), branch per kind below — C parses per
    // branch, but the computation is effect-free and identical.
    const lenHit = isLength();
    const { digits, idx } = parseIndex();
    // BYTES: .length and canonical-index byte reads answer like Node.
    {
      const isB = B.tmp();
      B.line(`${isB} = icmp eq i32 ${kd}, ${DYN_KIND.BYTES}`);
      const lB = B.newLabel("kg.by");
      const lNext = B.newLabel("kg.n");
      B.condBr(isB, lB, lNext);
      B.startBlock(lB);
      host.declare(`declare ptr @scr_dyn_bytes_key_get(ptr, ptr)`);
      const result = B.tmp();
      B.line(`${result} = call ptr @scr_dyn_bytes_key_get(ptr %d, ptr %k)`);
      B.terminate(`ret ptr ${result}`);
      B.startBlock(lNext);
    }
    // FUNC: own props (defineProperties writes), then name/length.
    {
      const isF = B.tmp();
      B.line(`${isF} = icmp eq i32 ${kd}, ${DYN_KIND.FUNC}`);
      const lF = B.newLabel("kg.fn");
      const lNext = B.newLabel("kg.n");
      B.condBr(isF, lF, lNext);
      B.startBlock(lF);
      host.declare(`declare ptr @scr_dyn_fn_get(ptr, ptr, ${host.sizeType})`);
      const m = B.tmp();
      B.line(
        `${m} = call ptr @scr_dyn_fn_get(ptr %d, ptr ${kParts.data}, ${host.sizeType} ${kParts.len})`,
      );
      const has = B.tmp();
      B.line(`${has} = icmp ne ptr ${m}, null`);
      const lHit = B.newLabel("kg.fh");
      const lMiss = B.newLabel("kg.fm");
      B.condBr(has, lHit, lMiss);
      B.startBlock(lHit);
      B.terminate(`ret ptr ${m}`);
      B.startBlock(lMiss);
      retainUndef();
      B.startBlock(lNext);
    }
    // ARR / STR: length + canonical-index element/char reads.
    {
      const isA = B.tmp();
      const isS = B.tmp();
      const either = B.tmp();
      B.line(`${isA} = icmp eq i32 ${kd}, ${DYN_KIND.ARR}`);
      B.line(`${isS} = icmp eq i32 ${kd}, ${DYN_KIND.STR}`);
      B.line(`${either} = or i1 ${isA}, ${isS}`);
      const lAS = B.newLabel("kg.as");
      const lNext = B.newLabel("kg.n");
      B.condBr(either, lAS, lNext);
      B.startBlock(lAS);
      host.declare(`declare double @scr_str_utf16_len(ptr)`);
      host.declare(`declare ptr @scr_dyn_new_num(double)`);
      const lLen = B.newLabel("kg.al");
      const lIdx = B.newLabel("kg.ai");
      B.condBr(lenHit, lLen, lIdx);
      B.startBlock(lLen);
      {
        const lArr = B.newLabel("kg.aa");
        const lStr = B.newLabel("kg.asr");
        B.condBr(isA, lArr, lStr);
        B.startBlock(lArr);
        const n = this.lenOf(B, "%d");
        const nd = B.tmp();
        const r = B.tmp();
        B.line(`${nd} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${n} to double`);
        B.line(`${r} = call ptr @scr_dyn_new_num(double ${nd})`);
        B.terminate(`ret ptr ${r}`);
        B.startBlock(lStr);
        const s = this.payloadOf(B, "%d", "ptr");
        const n2 = B.tmp();
        const r2 = B.tmp();
        B.line(`${n2} = call double @scr_str_utf16_len(ptr ${s})`);
        B.line(`${r2} = call ptr @scr_dyn_new_num(double ${n2})`);
        B.terminate(`ret ptr ${r2}`);
      }
      B.startBlock(lIdx);
      {
        const lTry = B.newLabel("kg.at");
        const lMiss = B.newLabel("kg.am");
        B.condBr(digits, lTry, lMiss);
        B.startBlock(lTry);
        const lArr = B.newLabel("kg.ae");
        const lStr = B.newLabel("kg.ac");
        B.condBr(isA, lArr, lStr);
        B.startBlock(lArr);
        const n = this.lenOf(B, "%d");
        const inR = B.tmp();
        B.line(`${inR} = icmp ult ${host.sizeType} ${idx}, ${n}`);
        const lHit = B.newLabel("kg.ah");
        B.condBr(inR, lHit, lMiss);
        B.startBlock(lHit);
        const items = this.itemsOf(B, "%d");
        const e = this.itemAt(B, items, idx);
        const r = this.retainDyn(B, e);
        B.terminate(`ret ptr ${r}`);
        B.startBlock(lStr);
        host.declare(`declare ptr @scr_str_char_at(ptr, double)`);
        host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
        host.declare(`declare void @scr_str_release(ptr)`);
        const s = this.payloadOf(B, "%d", "ptr");
        const n2 = B.tmp();
        B.line(`${n2} = call double @scr_str_utf16_len(ptr ${s})`);
        const idxD = B.tmp();
        B.line(`${idxD} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${idx} to double`);
        const inR2 = B.tmp();
        B.line(`${inR2} = fcmp olt double ${idxD}, ${n2}`);
        const lHit2 = B.newLabel("kg.ash");
        B.condBr(inR2, lHit2, lMiss);
        B.startBlock(lHit2);
        const ch = B.tmp();
        B.line(`${ch} = call ptr @scr_str_char_at(ptr ${s}, double ${idxD})`);
        const r2 = B.tmp();
        B.line(`${r2} = call ptr @scr_dyn_new_str(ptr ${ch})`);
        B.line(`call void @scr_str_release(ptr ${ch})`);
        B.terminate(`ret ptr ${r2}`);
        B.startBlock(lMiss);
        const lArrNamed = B.newLabel("kg.an");
        const lOther = B.newLabel("kg.ao");
        B.condBr(isA, lArrNamed, lOther);
        B.startBlock(lArrNamed);
        host.declare(`declare ptr @scr_dyn_arr_named_get(ptr, ptr)`);
        const named = B.tmp();
        B.line(`${named} = call ptr @scr_dyn_arr_named_get(ptr %d, ptr %k)`);
        B.terminate(`ret ptr ${named}`);
        B.startBlock(lOther);
        retainUndef();
      }
      B.startBlock(lNext);
    }
    retainUndef();
    this.defs.push(
      `define internal ptr @${name}(ptr %d, ptr %k, i1 zeroext %opt) ${FN_ATTRS} { ; d[k] on dyn`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── destructuring RequireObjectCoercible (ported) ─────────────────── */

  dynDestrCheckHelper(): string {
    const memoKey = "%dynDestrCheck";
    const existing = this.dynBuilders.get(memoKey);
    if (existing) return existing;
    const name = "sc_dyn_destr_check";
    this.dynBuilders.set(memoKey, name);
    this.host.journalAllocated?.(name, "dyn.dynDestrCheckHelper", []);
    const host = this.host;
    host.declare(`declare void @scr_jb_init(ptr)`);
    host.declare(`declare ptr @scr_jb_finish(ptr)`);
    host.declare(`declare void @scr_jb_puts(ptr, ptr)`);
    host.declare(`declare void @scr_throw_error(i32, ptr)`);
    const B = new BlockBuilder();
    const kd = this.kindOf(B, "%d");
    const isU = B.tmp();
    const isN = B.tmp();
    const unit = B.tmp();
    B.line(`${isU} = icmp eq i32 ${kd}, ${DYN_KIND.UNDEF}`);
    B.line(`${isN} = icmp eq i32 ${kd}, ${DYN_KIND.NULL}`);
    B.line(`${unit} = or i1 ${isU}, ${isN}`);
    const lThrow = B.newLabel("ddc.t");
    const lOk = B.newLabel("ddc.o");
    B.condBr(unit, lThrow, lOk);
    B.startBlock(lOk);
    B.terminate(`ret void`);
    B.startBlock(lThrow);
    const buf = "%ddb";
    B.entryAllocas.push(`${buf} = alloca %ScrJsonBuf`);
    B.line(`call void @scr_jb_init(ptr ${buf})`);
    const hasProp = B.tmp();
    B.line(`${hasProp} = icmp ne ptr %firstProp, null`);
    const lProp = B.newLabel("ddc.p");
    const lBare = B.newLabel("ddc.b");
    const lTail = B.newLabel("ddc.e");
    B.condBr(hasProp, lProp, lBare);
    B.startBlock(lProp);
    this.puts(B, buf, "Cannot destructure property '");
    B.line(`call void @scr_jb_puts(ptr ${buf}, ptr %firstProp)`);
    this.puts(B, buf, "' of '");
    B.line(`call void @scr_jb_puts(ptr ${buf}, ptr %spell)`);
    this.puts(B, buf, "' as it is ");
    B.br(lTail);
    B.startBlock(lBare);
    this.puts(B, buf, "Cannot destructure '");
    B.line(`call void @scr_jb_puts(ptr ${buf}, ptr %spell)`);
    this.puts(B, buf, "' as it is ");
    B.br(lTail);
    B.startBlock(lTail);
    const tail = B.tmp();
    B.line(`${tail} = select i1 ${isU}, ptr ${host.cstr("undefined.")}, ptr ${host.cstr("null.")}`);
    B.line(`call void @scr_jb_puts(ptr ${buf}, ptr ${tail})`);
    const msg = B.tmp();
    B.line(`${msg} = call ptr @scr_jb_finish(ptr ${buf})`);
    B.line(`call void @scr_throw_error(i32 1, ptr ${msg}) ; SCR_ERR_TYPE`);
    B.terminate(`ret void`);
    this.defs.push(
      `define internal void @${name}(ptr %d, ptr %spell, ptr %firstProp) ${FN_ATTRS} { ; destructuring RequireObjectCoercible`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── GetIterator + first-N steps (dynIterNHelper, ported) ──────────── */

  dynIterNHelper(): string {
    const memoKey = "%dynIterN";
    const existing = this.dynBuilders.get(memoKey);
    if (existing) return existing;
    const name = "sc_dyn_iter_n";
    this.dynBuilders.set(memoKey, name);
    this.host.journalAllocated?.(name, "dyn.dynIterNHelper", []);
    const host = this.host;
    host.declare(`declare ptr @scr_dyn_new_arr()`);
    host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
    host.declare(`declare ptr @scr_dyn_new_num(double)`);
    host.declare(`declare void @scr_str_release(ptr)`);
    const B = new BlockBuilder();
    const kd = this.kindOf(B, "%d");
    // Typed stream capsules iterate their cached, refreshed dyn view.
    {
      const isTyped = B.tmp();
      B.line(`${isTyped} = icmp eq i32 ${kd}, ${DYN_KIND.TYPED_REF}`);
      const lTyped = B.newLabel("din.tr");
      const lNext = B.newLabel("din.nt");
      B.condBr(isTyped, lTyped, lNext);
      B.startBlock(lTyped);
      // Compiled generators step through the iterator protocol.
      host.declare(`declare i1 @scr_dyn_iterates_by_protocol(ptr)`);
      host.declare(`declare ptr @scr_dyn_iter_take(ptr, ${host.sizeType}, ptr)`);
      const protocol = B.tmp();
      const lProtocol = B.newLabel("din.pr");
      const lView = B.newLabel("din.vw");
      B.line(`${protocol} = call i1 @scr_dyn_iterates_by_protocol(ptr %d)`);
      B.condBr(protocol, lProtocol, lView);
      B.startBlock(lProtocol);
      const stepped = B.tmp();
      B.line(
        `${stepped} = call ptr @scr_dyn_iter_take(ptr %d, ${host.sizeType} %n, ptr %spelling)`,
      );
      B.terminate(`ret ptr ${stepped}`);
      B.startBlock(lView);
      host.declare(`declare ptr @scr_dyn_typed_ref_materialize(ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      const materialized = B.tmp();
      const out = B.tmp();
      B.line(`${materialized} = call ptr @scr_dyn_typed_ref_materialize(ptr %d)`);
      B.line(`${out} = call ptr @${name}(ptr ${materialized}, ${host.sizeType} %n, ptr %spelling)`);
      B.line(`call void @scr_dyn_release_v(ptr ${materialized})`);
      B.terminate(`ret ptr ${out}`);
      B.startBlock(lNext);
    }

    const okA = B.tmp();
    const okS = B.tmp();
    const okB = B.tmp();
    const ok01 = B.tmp();
    const ok = B.tmp();
    B.line(`${okA} = icmp eq i32 ${kd}, ${DYN_KIND.ARR}`);
    B.line(`${okS} = icmp eq i32 ${kd}, ${DYN_KIND.STR}`);
    B.line(`${okB} = icmp eq i32 ${kd}, ${DYN_KIND.BYTES}`);
    B.line(`${ok01} = or i1 ${okA}, ${okS}`);
    B.line(`${ok} = or i1 ${ok01}, ${okB}`);
    const lGo = B.newLabel("din.g");
    const lThrow = B.newLabel("din.t");
    B.condBr(ok, lGo, lThrow);
    // Other iterables step through the iterator protocol; non-iterables
    // throw V8's exact not-iterable TypeError.
    B.startBlock(lThrow);
    host.declare(`declare ptr @scr_dyn_iter_take(ptr, ${host.sizeType}, ptr)`);
    const taken = B.tmp();
    B.line(`${taken} = call ptr @scr_dyn_iter_take(ptr %d, ${host.sizeType} %n, ptr %spelling)`);
    B.terminate(`ret ptr ${taken}`);
    B.startBlock(lGo);
    const out = B.tmp();
    B.line(`${out} = call ptr @scr_dyn_new_arr()`);
    this.i64Loop(B, "din", "%n", (i) => {
      const itemSlot = B.slot();
      B.entryAllocas.push(`${itemSlot} = alloca ptr`);
      const lArr = B.newLabel("din.ia");
      const lBy = B.newLabel("din.ib");
      const lStr = B.newLabel("din.is");
      const lPush = B.newLabel("din.ip");
      const lNotA = B.newLabel("din.na");
      B.condBr(okA, lArr, lNotA);
      B.startBlock(lNotA);
      B.condBr(okB, lBy, lStr);
      // ARR: item = i < len ? retain(items[i]) : retain(undefined)
      B.startBlock(lArr);
      {
        const n = this.lenOf(B, "%d");
        const inR = B.tmp();
        B.line(`${inR} = icmp ult ${host.sizeType} ${i}, ${n}`);
        const lHit = B.newLabel("din.ah");
        const lMiss = B.newLabel("din.am");
        B.condBr(inR, lHit, lMiss);
        B.startBlock(lHit);
        const items = this.itemsOf(B, "%d");
        const e = this.itemAt(B, items, i);
        const r = this.retainDyn(B, e);
        B.line(`store ptr ${r}, ptr ${itemSlot}`);
        B.br(lPush);
        B.startBlock(lMiss);
        const u = this.undef(B);
        const r2 = this.retainDyn(B, u);
        B.line(`store ptr ${r2}, ptr ${itemSlot}`);
        B.br(lPush);
      }
      // BYTES: by numeric element.
      B.startBlock(lBy);
      {
        const bts = this.payloadOf(B, "%d", "ptr");
        const blenp = B.tmp();
        const blen = B.tmp();
        B.line(
          `${blenp} = getelementptr inbounds i8, ptr ${bts}, i64 ${this.abiOffset(8, 4)} ; ->len`,
        );
        B.line(`${blen} = load ${host.sizeType}, ptr ${blenp}`);
        const inR = B.tmp();
        B.line(`${inR} = icmp ult ${host.sizeType} ${i}, ${blen}`);
        const lHit = B.newLabel("din.bh");
        const lMiss = B.newLabel("din.bm");
        B.condBr(inR, lHit, lMiss);
        B.startBlock(lHit);
        host.declare(`declare double @scr_bytes_get(ptr, double)`);
        const index = B.tmp();
        const bd = B.tmp();
        const r = B.tmp();
        B.line(`${index} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${i} to double`);
        B.line(`${bd} = call double @scr_bytes_get(ptr ${bts}, double ${index})`);
        B.line(`${r} = call ptr @scr_dyn_new_num(double ${bd})`);
        B.line(`store ptr ${r}, ptr ${itemSlot}`);
        B.br(lPush);
        B.startBlock(lMiss);
        const u = this.undef(B);
        const r2 = this.retainDyn(B, u);
        B.line(`store ptr ${r2}, ptr ${itemSlot}`);
        B.br(lPush);
      }
      // STR: whole code POINTS (the string iterator, not charAt).
      B.startBlock(lStr);
      {
        host.declare(`declare double @scr_str_utf16_len(ptr)`);
        host.declare(`declare ptr @scr_str_cp_at(ptr, double)`);
        host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
        const s = this.payloadOf(B, "%d", "ptr");
        const len = B.tmp();
        B.line(`${len} = call double @scr_str_utf16_len(ptr ${s})`);
        const atSlot = B.slot();
        const stepSlot = B.slot();
        B.entryAllocas.push(`${atSlot} = alloca double`, `${stepSlot} = alloca ${host.sizeType}`);
        B.line(`store double ${f64Lit(0)}, ptr ${atSlot}`);
        B.line(`store ${host.sizeType} 0, ptr ${stepSlot}`);
        const lc = B.newLabel("din.sc");
        const lb = B.newLabel("din.sb");
        const le = B.newLabel("din.se");
        B.br(lc);
        B.startBlock(lc);
        const st = B.tmp();
        const at = B.tmp();
        const c1 = B.tmp();
        const c2 = B.tmp();
        const cont = B.tmp();
        B.line(`${st} = load ${host.sizeType}, ptr ${stepSlot}`);
        B.line(`${at} = load double, ptr ${atSlot}`);
        B.line(`${c1} = icmp ult ${host.sizeType} ${st}, ${i}`);
        B.line(`${c2} = fcmp olt double ${at}, ${len}`);
        B.line(`${cont} = and i1 ${c1}, ${c2}`);
        B.condBr(cont, lb, le);
        B.startBlock(lb);
        const cp = B.tmp();
        const cpl = B.tmp();
        const at2 = B.tmp();
        B.line(`${cp} = call ptr @scr_str_cp_at(ptr ${s}, double ${at})`);
        B.line(`${cpl} = call double @scr_str_utf16_len(ptr ${cp})`);
        B.line(`${at2} = fadd double ${at}, ${cpl}`);
        B.line(`store double ${at2}, ptr ${atSlot}`);
        B.line(`call void @scr_str_release(ptr ${cp})`);
        const st2 = B.tmp();
        B.line(`${st2} = add ${host.sizeType} ${st}, 1`);
        B.line(`store ${host.sizeType} ${st2}, ptr ${stepSlot}`);
        B.br(lc);
        B.startBlock(le);
        const atF = B.tmp();
        B.line(`${atF} = load double, ptr ${atSlot}`);
        const inR = B.tmp();
        B.line(`${inR} = fcmp olt double ${atF}, ${len}`);
        const lHit = B.newLabel("din.sh");
        const lMiss = B.newLabel("din.sm");
        B.condBr(inR, lHit, lMiss);
        B.startBlock(lHit);
        const cp2 = B.tmp();
        const r = B.tmp();
        B.line(`${cp2} = call ptr @scr_str_cp_at(ptr ${s}, double ${atF})`);
        B.line(`${r} = call ptr @scr_dyn_new_str(ptr ${cp2})`);
        B.line(`call void @scr_str_release(ptr ${cp2})`);
        B.line(`store ptr ${r}, ptr ${itemSlot}`);
        B.br(lPush);
        B.startBlock(lMiss);
        const u = this.undef(B);
        const r2 = this.retainDyn(B, u);
        B.line(`store ptr ${r2}, ptr ${itemSlot}`);
        B.br(lPush);
      }
      B.startBlock(lPush);
      const item = B.tmp();
      B.line(`${item} = load ptr, ptr ${itemSlot}`);
      B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${item}) ; push takes ownership`);
    });
    B.terminate(`ret ptr ${out}`);
    this.defs.push(
      `define internal ptr @${name}(ptr %d, ${host.sizeType} %n, ptr %spelling) ${FN_ATTRS} { ; destructuring GetIterator + N steps`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /* ── the checked-dynamic function boundary (ported) ────────────────── */

  /** The dyn argument spelling of one static value: dyn passes through
   * (+1), funcs box anonymously, everything else rides toDyn. `expr` is
   * BORROWED in every arm. Emits into the given builder. */
  /** A live capsule of a record or array value (+1; the value is
   * borrowed), as `dynFrom` with `liveRef` builds it; null for other
   * types. Closures boxed in a declaration-typed boundary program return
   * their records and arrays this way. */
  private liveToDyn(B: BlockBuilder, t: IrType, expr: string): string | null {
    const host = this.host;
    if (t.kind === "union") {
      const arms = host.unionsById.get(t.unionId)?.arms ?? [];
      if (!arms.some((arm) => arm.kind === "record" || arm.kind === "array")) return null;
      const boxed = B.tmp();
      B.line(`${boxed} = call ptr @${host.liveDynUnionRefAdapter(t)}(ptr ${expr})`);
      return boxed;
    }
    if ((t.kind !== "record" && t.kind !== "array") || !streamTypedRefEligible(t)) return null;
    const key = typeKey(t);
    const adapter = host.liveDynRefAdapter(t);
    const rc = vAdapters(host, t);
    const boxed = B.tmp();
    B.line(
      `${boxed} = call ptr ${typedRefConstructor(host, t)}(ptr ${expr}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
    );
    for (const line of bindLiveArrayOps(host, adapter, boxed)) B.line(line);
    return boxed;
  }

  private toDynExpr(B: BlockBuilder, t: IrType, expr: string): string {
    if (t.kind === "dyn") return this.retainDyn(B, expr);
    if (t.kind === "func") {
      const box = this.dynFuncBoxHelper(t);
      const r = B.tmp();
      B.line(`${r} = call ptr @${box}(ptr ${expr}, ptr null)`);
      return r;
    }

    const r = B.tmp();
    B.line(`${r} = call ptr @${this.toDynHelper(t)}(${this.valTy(t)} ${expr})`);
    return r;
  }

  /** The call thunk for one closure signature: validate each dyn arg
   * into the declared param type, call through the closure, convert the
   * result back to a dyn value (+1). */
  dynFuncThunkHelper(t: IrType & { kind: "func" }): string {
    const key = typeKey(t);
    const existing = this.dynFuncThunks.get(key);
    if (existing) return existing;
    const name = `sc_dfk_${this.dynFuncThunks.size}`;
    this.dynFuncThunks.set(key, name);
    this.host.journalAllocated?.(name, "dyn.dynFuncThunkHelper", [t]);
    const host = this.host;
    const B = new BlockBuilder();
    const argNames: string[] = [];
    const typedRest = t.rest === true && t.restAbi === "typed";
    const packTail = (start: number): string => {
      host.declare(`declare ptr @scr_dyn_new_arr()`);
      host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
      const packed = B.tmp();
      B.line(`${packed} = call ptr @scr_dyn_new_arr()`);
      const riSlot = B.slot();
      B.entryAllocas.push(`${riSlot} = alloca ${host.sizeType}`);
      B.line(`store ${host.sizeType} ${start}, ptr ${riSlot}`);
      const lc = B.newLabel("dfk.rc");
      const lb = B.newLabel("dfk.rb");
      const le = B.newLabel("dfk.re");
      B.br(lc);
      B.startBlock(lc);
      const ri = B.tmp();
      const cont = B.tmp();
      B.line(`${ri} = load ${host.sizeType}, ptr ${riSlot}`);
      B.line(`${cont} = icmp ult ${host.sizeType} ${ri}, %argc`);
      B.condBr(cont, lb, le);
      B.startBlock(lb);
      const ap = B.tmp();
      const av = B.tmp();
      B.line(`${ap} = getelementptr inbounds ptr, ptr %args, ${host.sizeType} ${ri}`);
      B.line(`${av} = load ptr, ptr ${ap}`);
      const rv = this.retainDyn(B, av);
      B.line(`call void @scr_dyn_arr_push(ptr ${packed}, ptr ${rv})`);
      const ri2 = B.tmp();
      B.line(`${ri2} = add ${host.sizeType} ${ri}, 1`);
      B.line(`store ${host.sizeType} ${ri2}, ptr ${riSlot}`);
      B.br(lc);
      B.startBlock(le);
      return packed;
    };
    t.params.forEach((p, i) => {
      if (typedRest && i === t.params.length - 1) {
        const packed = packTail(i);
        const a = B.tmp();
        B.line(`${a} = call ${this.valTy(p)} @${this.dynCheckHelper(p)}(ptr ${packed}, ptr null)`);
        host.declare(`declare void @scr_dyn_release(ptr)`);
        B.line(`call void @scr_dyn_release(ptr ${packed})`);
        this.pendingBail(
          B,
          "dfk.rest",
          () => {
            t.params.slice(0, i).forEach((q, j) => {
              if (isRefCounted(q)) B.line(`call void ${releaseSym(host, q)}(ptr ${argNames[j]})`);
            });
          },
          "ptr null",
        );
        argNames.push(a);
        return;
      }
      // JS arity: a missing argument IS the undefined dyn value.
      const adSlot = B.slot();
      B.entryAllocas.push(`${adSlot} = alloca ptr`);
      const has = B.tmp();
      B.line(`${has} = icmp ult ${host.sizeType} ${i}, %argc`);
      const lHas = B.newLabel("dfk.h");
      const lMiss = B.newLabel("dfk.m");
      const lj = B.newLabel("dfk.j");
      B.condBr(has, lHas, lMiss);
      B.startBlock(lHas);
      const ap = B.tmp();
      const av = B.tmp();
      B.line(`${ap} = getelementptr inbounds ptr, ptr %args, ${host.sizeType} ${i}`);
      B.line(`${av} = load ptr, ptr ${ap}`);
      B.line(`store ptr ${av}, ptr ${adSlot}`);
      B.br(lj);
      B.startBlock(lMiss);
      const u = this.undef(B);
      B.line(`store ptr ${u}, ptr ${adSlot}`);
      B.br(lj);
      B.startBlock(lj);
      const ad = B.tmp();
      B.line(`${ad} = load ptr, ptr ${adSlot}`);
      if (p.kind === "dyn") {
        argNames.push(this.retainDyn(B, ad));
      } else {
        const pathSlot = B.slot();
        B.entryAllocas.push(`${pathSlot} = alloca %ScrDynPath`);
        const pp = B.tmp();
        const kp2 = B.tmp();
        const ip = B.tmp();
        B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
        B.line(`store ptr null, ptr ${pp}`);
        B.line(`${kp2} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
        B.line(`store ptr null, ptr ${kp2}`);
        B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
        B.line(`store ${host.sizeType} ${i}, ptr ${ip}`);
        const a = B.tmp();
        B.line(
          `${a} = call ${this.valTy(p)} @${this.dynCheckHelper(p)}(ptr ${ad}, ptr ${pathSlot})`,
        );
        this.pendingBail(
          B,
          "dfk",
          () => {
            t.params.slice(0, i).forEach((q, j) => {
              if (isRefCounted(q)) B.line(`call void ${releaseSym(host, q)}(ptr ${argNames[j]})`);
            });
          },
          "ptr null",
        );
        // Declaration-typed boundary programs: an argument package code
        // passes keeps its identity (scr_dyn_decl_adopt).
        const capsule = this.host.declBoundary?.() === true ? this.liveToDyn(B, p, a) : null;
        if (capsule !== null) {
          host.declare(`declare void @scr_dyn_decl_adopt(ptr, ptr)`);
          host.declare(`declare void @scr_dyn_release(ptr)`);
          B.line(`call void @scr_dyn_decl_adopt(ptr ${ad}, ptr ${capsule})`);
          B.line(`call void @scr_dyn_release(ptr ${capsule})`);
          this.pendingBail(
            B,
            "dfk.adopt",
            () => {
              t.params.slice(0, i + 1).forEach((q, j) => {
                const name = j === i ? a : argNames[j];
                if (isRefCounted(q)) B.line(`call void ${releaseSym(host, q)}(ptr ${name})`);
              });
            },
            "ptr null",
          );
        }
        argNames.push(a);
      }
    });
    // VARIADIC (rest-marked) signatures: one extra trailing dyn-array
    // param carries the call's arguments from index params.length on.
    const rest = t.rest && !typedRest ? packTail(t.argumentsAll ? 0 : t.params.length) : null;
    // The closure CONSUMES its params (+1 each moved in).
    const fnp = B.tmp();
    const fn = B.tmp();
    B.line(`${fnp} = getelementptr inbounds %ScrClosure, ptr %c, i64 0, i32 1`);
    B.line(`${fn} = load ptr, ptr ${fnp}`);
    const retTy = t.ret.kind === "void" ? "void" : this.valTy(t.ret);
    const callArgs = [
      `ptr %c`,
      ...t.params.map((p, i) => `${this.valTy(p)} ${argNames[i]}`),
      ...(rest !== null ? [`ptr ${rest}`] : []),
    ].join(", ");
    if (t.ret.kind === "void") {
      B.line(`call void ${fn}(${callArgs})`);
      this.pendingBail(B, "dfkr", () => {}, "ptr null");
      const u = this.undef(B);
      const r = this.retainDyn(B, u);
      B.terminate(`ret ptr ${r}`);
    } else if (t.ret.kind === "dyn") {
      const r = B.tmp();
      B.line(`${r} = call ptr ${fn}(${callArgs})`);
      this.pendingBail(B, "dfkr", () => {}, "ptr null");
      B.terminate(`ret ptr ${r}`);
    } else {
      const r = B.tmp();
      B.line(`${r} = call ${retTy} ${fn}(${callArgs})`);
      this.pendingBail(B, "dfkr", () => {}, "ptr null");
      const out =
        this.host.declBoundary?.() === true
          ? (this.liveToDyn(B, t.ret, r) ?? this.toDynExpr(B, t.ret, r))
          : this.toDynExpr(B, t.ret, r);
      if (isRefCounted(t.ret)) B.line(`call void ${releaseSym(host, t.ret)}(ptr ${r})`);
      B.terminate(`ret ptr ${out}`);
    }
    this.defs.push(
      `define internal ptr @${name}(ptr %c, ptr %args, ${host.sizeType} %argc) ${FN_ATTRS} { ; dyn call thunk for ${key}`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /** The box builder dynFrom emits for one closure signature. */
  dynFuncBoxHelper(t: IrType & { kind: "func" }): string {
    const key = typeKey(t);
    const existing = this.dynFuncBoxes.get(key);
    if (existing) return existing;
    const name = `sc_dfb_${this.dynFuncBoxes.size}`;
    this.dynFuncBoxes.set(key, name);
    this.host.journalAllocated?.(name, "dyn.dynFuncBoxHelper", [t]);
    const host = this.host;
    const thunk = this.dynFuncThunkHelper(t);
    host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
    host.declare(`declare ptr @scr_dyn_new_func(ptr, ptr, i32, ptr, ptr)`);
    const sigLit = host.cstr(key);
    this.defs.push(
      `define internal ptr @${name}(ptr %v, ptr %fname) ${FN_ATTRS} { ; box ${key} into dyn`,
      `entry:`,
      `  %c = call ptr @scr_closure_retain_v(ptr %v)`,
      `  %r = call ptr @scr_dyn_new_func(ptr %c, ptr @${thunk}, i32 ${t.params.length - (t.restAbi === "typed" ? 1 : 0)}, ptr ${sigLit}, ptr %fname)`,
      `  ret ptr %r`,
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /** `sc_dml_<n>(ptr c, ptr message) -> i1`, the typed message entry of a
   * closure registered as a 'message' listener (ScrDynMessageListener):
   * builds the closure's parameter from the message's nodes and calls the
   * closure. It answers false, without calling it, when the message does
   * not have the parameter's exact layout, and the listener then runs
   * through its thunk on the decoded message, as before. Null when the
   * signature's parameter has no message reader (messageReadable). */
  messageListenerHelper(t: IrType & { kind: "func" }): string | null {
    const key = typeKey(t);
    const existing = this.messageListeners.get(key);
    if (existing !== undefined) return existing;
    const param = t.params[0];
    const supported =
      t.params.length === 1 &&
      t.rest !== true &&
      param !== undefined &&
      (t.ret.kind === "void" || t.ret.kind === "f64" || t.ret.kind === "bool") &&
      this.messageReadable(param, new Set());
    if (!supported) {
      // A signature without an entry still takes a number.
      this.messageListeners.set(key, null);
      this.host.journalAllocated?.("", "dyn.messageListenerHelper", [t]);
      this.host.journalBuilt?.();
      return null;
    }
    const name = `sc_dml_${this.messageListeners.size}`;
    this.messageListeners.set(key, name);
    this.host.journalAllocated?.(name, "dyn.messageListenerHelper", [t]);
    const B = new BlockBuilder();
    B.entryAllocas.push(`%fail = alloca i1`);
    B.line(`store i1 false, ptr %fail`);
    const value = B.tmp();
    B.line(
      `${value} = call ${this.valTy(param)} @${this.messageReaderHelper(param)}(ptr %m, ${this.host.sizeType} 0, ptr %fail)`,
    );
    const failed = B.tmp();
    B.line(`${failed} = load i1, ptr %fail`);
    const lMiss = B.newLabel("dml.miss");
    const lCall = B.newLabel("dml.call");
    B.condBr(failed, lMiss, lCall);
    B.startBlock(lMiss);
    B.terminate(`ret i1 false`);
    B.startBlock(lCall);
    // The closure consumes its parameter; a pending exception stays for
    // the emitter, as after the thunk.
    const fnp = B.tmp();
    const fn = B.tmp();
    B.line(`${fnp} = getelementptr inbounds %ScrClosure, ptr %c, i64 0, i32 1`);
    B.line(`${fn} = load ptr, ptr ${fnp}`);
    const args = `ptr %c, ${this.valTy(param)} ${value}`;
    if (t.ret.kind === "void") B.line(`call void ${fn}(${args})`);
    else B.line(`${B.tmp()} = call ${this.valTy(t.ret)} ${fn}(${args})`);
    B.terminate(`ret i1 true`);
    this.defs.push(
      `define internal zeroext i1 @${name}(ptr %c, ptr %m) ${FN_ATTRS} { ; message entry for ${llvmCommentText(key)}`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /** Whether a message reader can build T: numbers, booleans and strings;
   * records of them with only declared fields, none of union type; and
   * boxed unions of those arms and null or undefined without a literal
   * discriminator, with at most one number, boolean and string arm. */
  private messageReadable(t: IrType, seen: Set<string>): boolean {
    switch (t.kind) {
      case "f64":
      case "bool":
      case "string":
        return true;
      case "record": {
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0) return false;
        if (seen.has(t.shapeId) || this.isRecursiveShape(t)) return false;
        seen.add(t.shapeId);
        const readable = shape.fields.every(
          (f) =>
            !f.name.startsWith("%") &&
            f.type.kind !== "union" &&
            llFieldType(f.type, this.host.inlineUnions.record(f.type)) !== INLINE_UNION_FIELD &&
            this.messageReadable(f.type, seen),
        );
        seen.delete(t.shapeId);
        return readable;
      }
      case "union": {
        const def = this.host.unionsById.get(t.unionId);
        // A discriminated union's checked conversion also tests the arm's
        // literal discriminator, which the readers do not.
        if (!def || def.discriminant || this.host.nullableUnions.has(t.unionId)) return false;
        const scalars = new Set<string>();
        for (const arm of def.arms) {
          if (arm.kind === "nullT" || arm.kind === "undefinedT") continue;
          if (arm.kind === "f64" || arm.kind === "bool" || arm.kind === "string") {
            if (scalars.has(arm.kind)) return false;
            scalars.add(arm.kind);
            continue;
          }
          if (arm.kind !== "record" || !this.messageReadable(arm, seen)) return false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** `sc_dmr_<n>(ptr message, size node, ptr fail) -> T`: T (+1) built
   * from a message node, for a type messageReadable accepts. Sets *fail
   * and returns a dummy when the node does not have T's layout: the arm
   * the checked conversion would choose, a record's declared keys in
   * declaration order and no others. */
  private messageReaderHelper(t: IrType): string {
    const key = typeKey(t);
    const existing = this.messageReaders.get(key);
    if (existing) return existing;
    const name = `sc_dmr_${this.messageReaders.size}`;
    this.messageReaders.set(key, name);
    this.host.journalAllocated?.(name, "dyn.messageReaderHelper", [t]);
    const host = this.host;
    const S = host.sizeType;
    if (t.kind !== "record") host.declare(`declare i32 @scr_message_kind(ptr, ${S})`);
    const retTy = this.valTy(t);
    const dummy = retTy === "double" ? f64Lit(0) : retTy === "i1" ? "false" : "null";
    const B = new BlockBuilder();
    const lFail = B.newLabel("dmr.fail");
    // scr_message_fields tests a record's kind itself.
    const kind = B.tmp();
    if (t.kind !== "record") B.line(`${kind} = call i32 @scr_message_kind(ptr %m, ${S} %n)`);
    const requireKind = (want: number): void => {
      const ok = B.tmp();
      B.line(`${ok} = icmp eq i32 ${kind}, ${want}`);
      const lOk = B.newLabel("dmr.kind");
      B.condBr(ok, lOk, lFail);
      B.startBlock(lOk);
    };
    switch (t.kind) {
      case "f64":
      case "bool": {
        host.declare(`declare double @scr_message_number(ptr, ${S})`);
        requireKind(t.kind === "f64" ? MESSAGE_KIND.NUMBER : MESSAGE_KIND.BOOL);
        const n = B.tmp();
        B.line(`${n} = call double @scr_message_number(ptr %m, ${S} %n)`);
        if (t.kind === "f64") B.terminate(`ret double ${n}`);
        else {
          const b = B.tmp();
          B.line(`${b} = fcmp une double ${n}, ${f64Lit(0)}`);
          B.terminate(`ret i1 ${b}`);
        }
        break;
      }
      case "string": {
        host.declare(`declare ptr @scr_message_string(ptr, ${S})`);
        requireKind(MESSAGE_KIND.STRING);
        const str = B.tmp();
        B.line(`${str} = call ptr @scr_message_string(ptr %m, ${S} %n)`);
        B.terminate(`ret ptr ${str}`);
        break;
      }
      case "record": {
        const shape = host.recordsById.get(t.shapeId)!;
        const order = recordSourceFieldOrder(shape);
        const fields = new Map(shape.fields.map((f, i) => [f.name, { field: f, index: i }]));
        const base = host.nullableUnions.fieldBase(t.shapeId);
        const struct = mangleRecordStruct(t.shapeId);
        const names = this.recordNameTable(t.shapeId, shape);
        host.declare(`declare zeroext i1 @scr_message_fields(ptr, ${S}, ptr, ptr, ${S}, ptr)`);
        B.entryAllocas.push(`%kids = alloca [${order.length} x ${S}]`);
        const matched = B.tmp();
        B.line(
          `${matched} = call zeroext i1 @scr_message_fields(ptr %m, ${S} %n, ptr ${names.names}, ptr ${names.lens}, ${S} ${order.length}, ptr %kids)`,
        );
        const lBuild = B.newLabel("dmr.build");
        B.condBr(matched, lBuild, lFail);
        B.startBlock(lBuild);
        B.line(`%r0 = call ptr @${mangleRecordNew(t.shapeId)}()`);
        order.forEach((fieldName, i) => {
          const { field, index } = fields.get(fieldName)!;
          const kidp = B.tmp();
          const kid = B.tmp();
          B.line(
            `${kidp} = getelementptr inbounds [${order.length} x ${S}], ptr %kids, i64 0, i64 ${i}`,
          );
          B.line(`${kid} = load ${S}, ptr ${kidp}`);
          const v = B.tmp();
          B.line(
            `${v} = call ${this.valTy(field.type)} @${this.messageReaderHelper(field.type)}(ptr %m, ${S} ${kid}, ptr %fail)`,
          );
          const failed = B.tmp();
          B.line(`${failed} = load i1, ptr %fail`);
          const lDrop = B.newLabel("dmr.drop");
          const lStore = B.newLabel("dmr.store");
          B.condBr(failed, lDrop, lStore);
          B.startBlock(lDrop);
          B.line(`call void ${releaseSym(host, t)}(ptr %r0)`);
          B.terminate(`ret ptr null`);
          B.startBlock(lStore);
          const p = B.tmp();
          B.line(
            `${p} = getelementptr inbounds %${struct}, ptr %r0, i64 0, i32 ${index + base} ; .${llvmCommentText(fieldName)}`,
          );
          const fieldTy = llFieldType(field.type, host.inlineUnions.record(field.type));
          if (fieldTy === "i8") {
            const z = B.tmp();
            B.line(`${z} = zext i1 ${v} to i8`);
            B.line(`store i8 ${z}, ptr ${p}`);
          } else {
            B.line(`store ${fieldTy} ${v}, ptr ${p}`);
          }
        });
        B.terminate(`ret ptr %r0`);
        break;
      }
      case "union": {
        const def = host.unionsById.get(t.unionId)!;
        def.arms.forEach((arm, i) => {
          const lNext = B.newLabel("dmr.next");
          if (arm.kind === "nullT" || arm.kind === "undefinedT") {
            const hit = B.tmp();
            B.line(
              `${hit} = icmp eq i32 ${kind}, ${arm.kind === "nullT" ? MESSAGE_KIND.NULL : MESSAGE_KIND.UNDEFINED}`,
            );
            const lHit = B.newLabel("dmr.unit");
            B.condBr(hit, lHit, lNext);
            B.startBlock(lHit);
            B.terminate(`ret ptr ${host.unitInstanceRef(t.unionId, i)}`);
            B.startBlock(lNext);
            return;
          }
          if (arm.kind !== "record") {
            const want =
              arm.kind === "f64"
                ? MESSAGE_KIND.NUMBER
                : arm.kind === "bool"
                  ? MESSAGE_KIND.BOOL
                  : MESSAGE_KIND.STRING;
            const hit = B.tmp();
            B.line(`${hit} = icmp eq i32 ${kind}, ${want}`);
            const lHit = B.newLabel("dmr.arm");
            B.condBr(hit, lHit, lNext);
            B.startBlock(lHit);
          }
          // A record arm that does not match leaves *fail clear for the
          // next arm, like the checked conversion's next-arm match.
          const v = B.tmp();
          B.line(
            `${v} = call ${this.valTy(arm)} @${this.messageReaderHelper(arm)}(ptr %m, ${S} %n, ptr %fail)`,
          );
          if (arm.kind === "record") {
            const failed = B.tmp();
            B.line(`${failed} = load i1, ptr %fail`);
            const lHit = B.newLabel("dmr.arm");
            const lMiss = B.newLabel("dmr.miss");
            B.condBr(failed, lMiss, lHit);
            B.startBlock(lMiss);
            B.line(`store i1 false, ptr %fail`);
            B.br(lNext);
            B.startBlock(lHit);
          }
          const u = B.tmp();
          if (arm.kind === "f64") {
            host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
            B.line(`${u} = call ptr @scr_union_new_f64(i32 ${i}, double ${v})`);
          } else if (arm.kind === "bool") {
            host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
            B.line(`${u} = call ptr @scr_union_new_bool(i32 ${i}, i1 ${v})`);
          } else {
            const rc = vAdapters(host, arm);
            host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
            B.line(
              `${u} = call ptr @scr_union_new_ref(i32 ${i}, ptr ${v}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, arm)})`,
            );
          }
          B.terminate(`ret ptr ${u}`);
          B.startBlock(lNext);
        });
        B.br(lFail);
        break;
      }
      default:
        throw new InternalCompilerError(`llvm emitter bug: message reader of ${key}`);
    }
    B.startBlock(lFail);
    B.line(`store i1 true, ptr %fail`);
    B.terminate(`ret ${retTy} ${dummy}`);
    this.defs.push(
      `define internal ${retTy === "i1" ? "zeroext i1" : retTy} @${name}(ptr %m, ${S} %n, ptr %fail) ${FN_ATTRS} { ; message reader for ${llvmCommentText(key)}`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }

  /** The adapter closure body for one TARGET signature: caps[0] is an
   * untraced obj-box owning the dyn function value. */
  dynFuncAdapterHelper(t: IrType & { kind: "func" }): string {
    const key = typeKey(t);
    const existing = this.dynFuncAdapters.get(key);
    if (existing) return existing;
    const name = `sc_dfa_${this.dynFuncAdapters.size}`;
    this.dynFuncAdapters.set(key, name);
    this.host.journalAllocated?.(name, "dyn.dynFuncAdapterHelper", [t]);
    const host = this.host;
    const B = new BlockBuilder();
    host.declare(`declare ptr @scr_box_get_ref(ptr)`);
    host.declare(`declare ptr @scr_dyn_call(ptr, ptr, ${host.sizeType}, ptr)`);
    host.declare(`declare void @scr_dyn_release(ptr)`);
    const retTy = t.ret.kind === "void" ? "void" : this.valTy(t.ret);
    const dummy =
      t.ret.kind === "void"
        ? "void"
        : retTy === "double"
          ? `double ${f64Lit(0)}`
          : retTy === "i1"
            ? "i1 false"
            : "ptr null";
    const capp = B.tmp();
    const box = B.tmp();
    B.line(`${capp} = getelementptr inbounds %ScrClosure, ptr %sc_env, i64 1 ; caps[0]`);
    B.line(`${box} = load ptr, ptr ${capp}`);
    const fnv = B.tmp();
    B.line(`${fnv} = call ptr @scr_box_get_ref(ptr ${box}) ; +1`);
    // The adapter OWNS its params (closure ABI); each converts to a dyn
    // argument (borrowed by the conversion) and releases.
    let argsPtr = "null";
    const argVals: string[] = [];
    const checkedRest = t.rest === true && t.restAbi === undefined;
    let packed: string | null = null;
    if (checkedRest) {
      host.declare(`declare ptr @scr_dyn_apply(ptr, ptr, ptr)`);
      host.declare(`declare ptr @scr_dyn_new_arr()`);
      host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
      host.declare(`declare void @scr_dyn_arr_push_spread(ptr, ptr, ptr)`);
      packed = t.argumentsAll ? "%rest" : B.tmp();
      if (!t.argumentsAll) B.line(`${packed} = call ptr @scr_dyn_new_arr()`);
      t.params.forEach((p, i) => {
        if (!t.argumentsAll) {
          const v = this.toDynExpr(B, p, `%a${i}`);
          B.line(`call void @scr_dyn_arr_push(ptr ${packed}, ptr ${v})`);
        }
        if (isRefCounted(p)) B.line(`call void ${releaseSym(host, p)}(ptr %a${i})`);
      });
      if (!t.argumentsAll) {
        B.line(
          `call void @scr_dyn_arr_push_spread(ptr ${packed}, ptr %rest, ptr ${host.cstr("")})`,
        );
        B.line(`call void @scr_dyn_release(ptr %rest)`);
      }
    } else if (t.params.length > 0) {
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${t.params.length} x ptr]`);
      t.params.forEach((p, i) => {
        const v = this.toDynExpr(B, p, `%a${i}`);
        argVals.push(v);
        const slotp = B.tmp();
        B.line(
          `${slotp} = getelementptr inbounds [${t.params.length} x ptr], ptr ${arr}, i64 0, ${host.sizeType} ${i}`,
        );
        B.line(`store ptr ${v}, ptr ${slotp}`);
        if (isRefCounted(p)) B.line(`call void ${releaseSym(host, p)}(ptr %a${i})`);
      });
      argsPtr = arr;
    }
    // The kind is FUNC by construction; `what` is unreachable — spelled
    // anyway (the C's "value").
    const r = B.tmp();
    if (packed) {
      B.line(
        `${r} = call ptr @scr_dyn_apply(ptr ${fnv}, ptr ${packed}, ptr ${host.cstr("value")})`,
      );
      B.line(`call void @scr_dyn_release(ptr ${packed})`);
    } else
      B.line(
        `${r} = call ptr @scr_dyn_call(ptr ${fnv}, ptr ${argsPtr}, ${host.sizeType} ${t.params.length}, ptr ${host.cstr("value")})`,
      );
    B.line(`call void @scr_dyn_release(ptr ${fnv})`);
    for (const v of argVals) B.line(`call void @scr_dyn_release(ptr ${v})`);
    this.pendingBail(B, "dfa", () => {}, dummy === "void" ? "void" : dummy);
    if (t.ret.kind === "void") {
      B.line(`call void @scr_dyn_release(ptr ${r})`);
      B.terminate(`ret void`);
    } else if (t.ret.kind === "dyn") {
      B.terminate(`ret ptr ${r}`);
    } else {
      // Validate the dyn result into the target's return type — a lying
      // wrapper throws the catchable TypeError here (path "$").
      const out = B.tmp();
      B.line(
        `${out} = call ${this.valTy(t.ret)} @${this.dynCheckHelper(t.ret)}(ptr ${r}, ptr null)`,
      );
      B.line(`call void @scr_dyn_release(ptr ${r})`);
      B.terminate(`ret ${this.valTy(t.ret)} ${out}`);
    }
    const params = [
      "ptr %sc_env",
      ...t.params.map((p, i) => `${this.valTy(p)} %a${i}`),
      ...(checkedRest ? ["ptr %rest"] : []),
    ].join(", ");
    this.defs.push(
      `define internal ${retTy === "i1" ? "zeroext i1" : retTy} @${name}(${params}) ${FN_ATTRS} { ; dyn fn adapter to ${key}`,
      B.render(),
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return name;
  }
}
