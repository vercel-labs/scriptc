/* Per-type publication walkers (@scriptc/threads publish).
 *
 * publish(root) hands the root and its static type's walker to the
 * runtime's scr_publish (scr_cycle.c), which runs a worklist. A walker
 * marks its object immortal (scr_pub_mark answers false when it already
 * was: the walk's visited test, so shared and cyclic structure is walked
 * once) and pushes every reference it holds, each with the walker of its
 * static type. Hierarchy members dispatch on the object's concrete class
 * (its vtable's preorder number) because a base-typed field may hold any
 * subclass. Strings, bigints, arrays, maps, sets and dyn values use runtime
 * walkers; arrays and maps receive the element, key and value walkers.
 *
 * Publishable values are those Node's structured clone accepts and that
 * hold no mutable native state: numbers, booleans, strings, bigints,
 * undefined and null, class instances, records, arrays, maps and sets of
 * publishable values, and plain dyn data. Static types over-approximate
 * what a graph holds (a base-typed `parent` field statically reaches every
 * subclass), so an unpublishable type — functions, promises, symbols,
 * regexes, dates, typed arrays, native handles, runtime-rooted classes
 * (errors, emitters, streams) — gets a refusing walker: publishing fails
 * with the Node.js implementation's TypeError only when such a value is
 * actually present, and the whole publish is then undone. With
 * SCRIPTC_PUBLISH_TRACE set, the runtime also prints the static path. */
import type { IrClassDef, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import { mapOf, STRING, typeKey } from "../../ir/ir.js";
import { mangleClassStruct, mangleRecordStruct } from "../mangle.js";
import { FN_ATTRS } from "./shapes.js";
import { COMPACT_ID_MASK, compactRefLoadLines } from "./classes.js";
import { shapeTagFn } from "./nullable-unions.js";
import type { InlineUnionFields } from "./inline-unions.js";
import { LlvmUnsupportedError } from "./unsupported.js";

export interface PublishHost {
  /** Chunk emitters only (emit-journal.ts): EmitJournal's allocated, built,
   * opened, used and entry. */
  journalAllocated?: ((name: string, op: string, args: readonly unknown[]) => void) | undefined;
  journalBuilt?: (() => void) | undefined;
  journalOpened?: ((op: string) => void) | undefined;
  journalUsed?: ((name: string, op: string, args: readonly unknown[]) => void) | undefined;
  journalEntry?: ((table: string, key: string, value: unknown) => void) | undefined;
  declare(decl: string): void;
  /** An interned NUL-terminated constant. */
  cstr(text: string): string;
  readonly sizeType: "i32" | "i64";
  /** RC-audit builds: every mark goes through scr_pub_mark, which records
   * the object's kind for the audit. */
  readonly rcAudit?: boolean;
  readonly tracedShapes: ReadonlySet<string>;
  readonly unionsById: ReadonlyMap<string, IrUnionDef>;
  readonly recordsById: ReadonlyMap<string, IrRecordShape>;
  /** Record fields that store a scalar union inline: plain bits, nothing
   * to push. */
  readonly inlineUnions: InlineUnionFields;
  /** The nullable-pointer representation of a union, when it has one. */
  nullableArm(t: IrType): IrType | null;
  /** The union's values are tagged record pointers (nullable-unions.ts). */
  shapeUnion(t: IrType): boolean;
  /** The struct index of a record shape's first field. */
  fieldBase(shapeId: string): number;
  /** Class layout: hierarchy membership, preorder interval, field slots
   * (with their storage types), runtime roots. */
  classInfo(className: string): PublishClassInfo;
  /** Every class whose preorder number lies in [pre, post]. */
  classesInInterval(pre: number, post: number): string[];
}

export interface PublishClassInfo {
  def: IrClassDef;
  hierarchy: boolean;
  pre: number;
  post: number;
  /** A runtime-provided root class (errors, emitters, streams). */
  runtimeRooted: boolean;
  /** Instances keep their class id in the rc word (classes.ts
   * LlClassMeta.idInRc). */
  idInRc: boolean;
  /** Instances have the 32-bit header (classes.ts LlClassMeta.compact). */
  compact: boolean;
  /** The class's own and inherited fields: GEP index and storage type;
   * `compressed` when the field holds a 32-bit reference (classes.ts
   * LlClassMeta.compressed), which the walker decodes. */
  fields: { name: string; index: number; type: IrType; compressed?: boolean }[];
}

/** scr_pub_mark's object kinds (SCR_PUB_KIND_* in scr_runtime.h), for the RC audit. */
const PUB_KIND_OBJECT = 4;
const PUB_KIND_UNION = 5;
/** SCR_PUB_CLASS_ID, or'ed into a kind: the object keeps its class id
 * in the high half of its rc word (classes.ts LlClassMeta.idInRc). */
const PUB_CLASS_ID = 0x100;
/** SCR_PUB_COMPACT, or'ed into a kind: the object has the 32-bit header
 * (classes.ts compactHeaderWord), whose top bit is the mark. */
const PUB_COMPACT = 0x200;
/** COMPACT_PUBLISHED as an i32 constant. */
const COMPACT_MARK = "-2147483648";
/** SCR_PUB_LOG_COUNT (scr_publish.c), in a log entry's `buf`: `rc` is the
 * count of the low half. */
const PUB_LOG_COUNT = "-2147483648";

const RUNTIME_WALKERS = {
  string: "@scr_pub_str_fn",
  bigint: "@scr_pub_leaf_fn",
  dyn: "@scr_pub_dyn_fn",
} as const;

export class PublishWalkers {
  private readonly walkers = new Map<string, string | null>();
  private readonly defsOut: string[] = [];
  private counter = 0;

  constructor(private readonly host: PublishHost) {}

  /** Journal replay (emit-journal.ts): builds or finds the walker a chunk
   * emitter recorded, and answers its name. */
  replayHelper(op: string, args: readonly unknown[]): string {
    if (op === "publish.walker")
      return this.walker(args[0] as IrType, args[1] as string, args[2] as SrcLoc)!;
    return this.refusal(args[0] as string, args[1] as string);
  }

  /** The definitions emitted so far (module-level LLVM text). */
  defs(): string[] {
    return this.defsOut;
  }

  /** Lines publishing the value `v` (an LLVM ptr of static type `t`), or
   * none for types that hold no references. */
  emitPublish(v: string, t: IrType, loc: SrcLoc): string[] {
    const root = this.host.nullableArm(t) ?? t;
    if (scalarRefusal(root)) {
      // A Date (or process stream) is a scalar here, but Node.js refuses it.
      this.host.declare(`declare void @scr_publish_refuse(ptr)`);
      return [`  call void @scr_publish_refuse(ptr ${this.host.cstr(refusalMessage(root))})`];
    }
    const fn = this.walker(t, "the published value", loc);
    if (fn === null) return [];
    this.host.journalUsed?.(fn, "publish.walker", [t, "the published value", loc]);
    this.host.declare(`declare void @scr_publish(ptr, ptr)`);
    return [`  call void @scr_publish(ptr ${v}, ptr ${fn})`];
  }

  /** The walker symbol for values of type `t` (null: nothing to walk). */
  walker(t: IrType, path: string, loc: SrcLoc): string | null {
    const arm = this.host.nullableArm(t);
    if (arm !== null) return this.walker(arm, path, loc);
    switch (t.kind) {
      case "f64":
      case "bool":
      case "undefinedT":
      case "nullT":
      case "void":
        return null;
      case "string":
      case "bigint":
      case "dyn": {
        const sym = RUNTIME_WALKERS[t.kind];
        this.host.declare(`declare void ${sym}(ptr, ptr)`);
        return sym;
      }
      case "object":
      case "record":
      case "array":
      case "map":
      case "set":
      case "union":
        break;
      default:
        return this.refusal(refusalMessage(t), `${typeKey(t)} at ${path}`);
    }
    const key = typeKey(t);
    const known = this.walkers.get(key);
    if (known !== undefined) return known;
    const sym = `@sc_pub_${this.counter++}`;
    this.walkers.set(key, sym);
    this.host.journalOpened?.("publish.walker");
    const body = this.body(t, sym, path, loc);
    this.defsOut.push(...body, ``);
    this.host.journalBuilt?.();
    return sym;
  }

  private readonly refusals = new Map<string, string>();

  /** A walker that refuses the publish when a value is actually present:
   * the Node.js implementation's TypeError, plus the static path for
   * SCRIPTC_PUBLISH_TRACE. */
  private refusal(message: string, detail: string): string {
    const key = `${message}\0${detail}`;
    const known = this.refusals.get(key);
    if (known !== undefined) return known;
    const sym = `@sc_pub_${this.counter++}`;
    this.refusals.set(key, sym);
    this.host.journalOpened?.("publish.refusal");
    this.host.declare(`declare void @scr_pub_refuse_at(ptr, ptr, ptr)`);
    this.defsOut.push(
      `define internal void ${sym}(ptr %o, ptr %ctx) ${FN_ATTRS} { ; refuse ${llvmComment(detail)}`,
      `entry:`,
      `  call void @scr_pub_refuse_at(ptr %ctx, ptr ${this.host.cstr(message)}, ptr ${this.host.cstr(detail)})`,
      `  ret void`,
      `}`,
      ``,
    );
    this.host.journalBuilt?.();
    return sym;
  }

  private declareRuntime(): void {
    this.host.declare(`declare zeroext i1 @scr_pub_mark(ptr, ptr, i1 zeroext, i32)`);
    this.host.declare(`declare void @scr_pub_push(ptr, ptr, ptr)`);
  }

  /** `define` lines for the walker `sym` of `t`. */
  private body(t: IrType, sym: string, path: string, loc: SrcLoc): string[] {
    this.declareRuntime();
    const head = `define internal void ${sym}(ptr %o, ptr %ctx) ${FN_ATTRS} { ; publish ${llvmComment(typeKey(t))}`;
    switch (t.kind) {
      case "array": {
        const elem = this.walker(t.elem, `${path}[element]`, loc);
        if (scalarRefusal(t.elem)) throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
        this.host.declare(`declare void @scr_pub_arr(ptr, ptr, ptr)`);
        return [
          head,
          `entry:`,
          `  call void @scr_pub_arr(ptr %o, ptr %ctx, ptr ${elem ?? "null"})`,
          `  ret void`,
          `}`,
        ];
      }
      case "map":
      case "set": {
        const keyType = t.kind === "map" ? t.key : t.elem;
        const k = this.walker(keyType, `${path}[key]`, loc);
        const v = t.kind === "map" ? this.walker(t.value, `${path}[value]`, loc) : null;
        if (scalarRefusal(keyType) || (t.kind === "map" && scalarRefusal(t.value)))
          throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
        this.host.declare(`declare void @scr_pub_map(ptr, ptr, ptr, ptr)`);
        return [
          head,
          `entry:`,
          `  call void @scr_pub_map(ptr %o, ptr %ctx, ptr ${k ?? "null"}, ptr ${v ?? "null"})`,
          `  ret void`,
          `}`,
        ];
      }
      case "union": {
        const def = this.host.unionsById.get(t.unionId);
        if (!def) throw new LlvmUnsupportedError(`publish of an unknown union ${t.unionId}`, loc);
        const arms = def.arms.map((arm, tag) => ({
          tag,
          fn: this.walker(arm, `${path} (as ${typeKey(arm)})`, loc),
        }));
        // Union arms are boxed pointers or plain scalars; a date arm would
        // hold time-value bits that no walker may push.
        if (def.arms.some((arm) => scalarRefusal(arm)))
          throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
        const live = arms.flatMap((a) =>
          a.fn === null
            ? []
            : [{ tag: a.tag, fn: a.fn, compact: this.compactRef(def.arms[a.tag]!) }],
        );
        if (this.host.shapeUnion(t)) {
          // The value is the record itself (or a unit encoding): no box to
          // mark; the arm's walker marks and walks the record.
          const lines = [head, `entry:`];
          lines.push(
            `  %tag = call i32 ${shapeTagFn(t.unionId)}(ptr %o)`,
            `  switch i32 %tag, label %done [ ${live.map((a) => `i32 ${a.tag}, label %arm${a.tag}`).join(" ")} ]`,
          );
          for (const a of live)
            lines.push(`arm${a.tag}:`, `  call void ${a.fn}(ptr %o, ptr %ctx)`, `  br label %done`);
          lines.push(`done:`, `  ret void`, `}`);
          return lines;
        }
        const lines = [
          head,
          `entry:`,
          // Union boxes always carry a collector header (scr_union_release).
          ...this.markLines(true, PUB_KIND_UNION),
          `walk:`,
        ];
        if (live.length === 0) lines.push(`  br label %done`);
        else {
          lines.push(
            `  %tagp = getelementptr inbounds %ScrUnion, ptr %o, i64 0, i32 1`,
            `  %tag = load i32, ptr %tagp`,
            `  %slotp = getelementptr inbounds %ScrUnion, ptr %o, i64 0, i32 5`,
            `  %slot = load ptr, ptr %slotp`,
            `  switch i32 %tag, label %done [ ${live.map((a) => `i32 ${a.tag}, label %arm${a.tag}`).join(" ")} ]`,
          );
          for (const a of live)
            lines.push(
              `arm${a.tag}:`,
              ...this.push("%slot", a.fn, `u${a.tag}`, a.compact),
              `  br label %done`,
            );
        }
        lines.push(`done:`, `  ret void`, `}`);
        return lines;
      }
      case "record": {
        const shape = this.host.recordsById.get(t.shapeId);
        if (!shape)
          throw new LlvmUnsupportedError(`publish of an unknown record ${t.shapeId}`, loc);
        const base = this.host.fieldBase(shape.id);
        const members = [
          ...shape.fields.flatMap((f, i) =>
            this.host.inlineUnions.record(f.type)
              ? []
              : [{ name: f.name, index: i + base, type: f.type }],
          ),
          ...(shape.indexValue
            ? [
                {
                  name: "[key: string]",
                  index: shape.fields.length + base,
                  type: mapOf(STRING, shape.indexValue),
                },
              ]
            : []),
        ];
        return this.objectBody(
          head,
          mangleRecordStruct(shape.id),
          this.host.tracedShapes.has(`record:${shape.id}`),
          members,
          path,
          loc,
        );
      }
      case "object":
        return this.classBody(t.className, head, path, loc);
      default:
        throw new LlvmUnsupportedError(`publish of ${typeKey(t)}`, loc);
    }
  }

  /** A class walker: the class itself, or a dispatch over every class of
   * its subtree when it belongs to a hierarchy. */
  private classBody(className: string, head: string, path: string, loc: SrcLoc): string[] {
    const info = this.host.classInfo(className);
    if (!info.hierarchy) return this.concreteClassBody(info, head, path, loc);
    const members = this.host.classesInInterval(info.pre, info.post);
    const cases = members.map((name) => {
      const sub = this.host.classInfo(name);
      const sym = `@sc_pub_${this.counter++}`;
      const subHead = `define internal void ${sym}(ptr %o, ptr %ctx) ${FN_ATTRS} { ; publish class ${llvmComment(name)}`;
      this.defsOut.push(...this.concreteClassBody(sub, subHead, `${path} (a ${name})`, loc), ``);
      return { pre: sub.pre, sym, name };
    });
    const lines = [
      head,
      `entry:`,
      ...(info.compact
        ? [
            `  %idw = load i32, ptr %o ; the class id (classes.ts compactHeaderWord)`,
            `  %id = and i32 %idw, ${COMPACT_ID_MASK}`,
            `  %idpre = add i32 %id, -1`,
            `  %pre = zext i32 %idpre to ${this.host.sizeType}`,
          ]
        : info.idInRc
          ? [
              `  %idp = getelementptr inbounds i8, ptr %o, i64 4 ; the class id (classes.ts classIdRcWord)`,
              `  %id = load i32, ptr %idp`,
              `  %idpre = add i32 %id, -1`,
              `  %pre = zext i32 %idpre to ${this.host.sizeType}`,
            ]
          : [
              `  %vtp = getelementptr inbounds ptr, ptr %o, i64 1`,
              `  %vt = load ptr, ptr %vtp`,
              `  %pre = load ${this.host.sizeType}, ptr %vt`,
            ]),
      `  switch ${this.host.sizeType} %pre, label %other [ ${cases.map((c) => `${this.host.sizeType} ${c.pre}, label %c${c.pre}`).join(" ")} ]`,
    ];
    for (const c of cases)
      lines.push(
        `c${c.pre}: ; ${llvmComment(c.name)}`,
        `  call void ${c.sym}(ptr %o, ptr %ctx)`,
        `  ret void`,
      );
    lines.push(`other:`, `  unreachable`, `}`);
    return lines;
  }

  private concreteClassBody(
    info: PublishClassInfo,
    head: string,
    path: string,
    loc: SrcLoc,
  ): string[] {
    if (info.runtimeRooted) {
      const refuse = this.refusal(
        info.def.name === "%Error" || info.def.base !== undefined
          ? "Cannot publish a Error object"
          : "Cannot publish this value",
        `${info.def.name} at ${path}`,
      );
      return [head, `entry:`, `  call void ${refuse}(ptr %o, ptr %ctx)`, `  ret void`, `}`];
    }
    return this.objectBody(
      head,
      mangleClassStruct(info.def.name),
      this.host.tracedShapes.has(`object:${info.def.name}`),
      info.fields,
      path,
      loc,
      info.idInRc,
      info.compact,
    );
  }

  /** The walker's mark of `%o`, continuing at `%walk` when it marked it and
   * at `%done` when it already was immortal or the publish was refused.
   * The common case is inline, scr_pub_mark's fast path against ScrPub's
   * leading fields (scr_publish.c): the publish is not refused, the log has
   * room, the count fits the log's 32 bits without an escape (64-bit
   * targets), and an object with a collector header leaves its candidate
   * buffer through scr_cyc_pub_take. Anything else calls scr_pub_mark, as
   * does every mark of an RC-audit build. */
  private markLines(cyc: boolean, kind: number, classId = false, compact = false): string[] {
    const flags = compact ? PUB_COMPACT : classId ? PUB_CLASS_ID : 0;
    const call = (name: string): string[] => [
      `  %${name} = call zeroext i1 @scr_pub_mark(ptr %ctx, ptr %o, i1 ${cyc ? "true" : "false"}, i32 ${kind | flags})`,
      `  br i1 %${name}, label %walk, label %done`,
    ];
    if (this.host.rcAudit === true) return call("m");
    const S = this.host.sizeType;
    // An object that keeps its class id in the rc word is marked and
    // logged through its count, the low half.
    // A compact object's header word is logged whole (the restore writes
    // the low 32 bits back) and marked by its top bit.
    const C = classId || compact ? "i32" : S;
    const field = (name: string, slot: number): string[] => [
      `  %${name}p = getelementptr inbounds ptr, ptr %ctx, i32 ${slot}`,
      `  %${name} = load ${S === "i64" ? "i64" : "i32"}, ptr %${name}p`,
    ];
    const lines = [
      `  %mrc = load ${C}, ptr %o`,
      compact ? `  %mimm = icmp slt i32 %mrc, 0` : `  %mimm = icmp eq ${C} %mrc, -1`,
      `  br i1 %mimm, label %done, label %mtest`,
      `mtest:`,
      `  %mrefp = getelementptr inbounds ptr, ptr %ctx, i32 6`,
      `  %mref = load ptr, ptr %mrefp`,
      `  %mok0 = icmp eq ptr %mref, null`,
      ...field("mlogged", 4),
      ...field("mcap", 5),
      `  %mroom = icmp ult ${S} %mlogged, %mcap`,
      `  %mok1 = and i1 %mok0, %mroom`,
    ];
    let ok = "%mok1";
    if (C === "i64") {
      // 0xfffffffe and up are the log's escapes (SCR_PUB_RC_LIFETIME, _BIG).
      lines.push(`  %msmall = icmp ult i64 %mrc, 4294967294`, `  %mok2 = and i1 %mok1, %msmall`);
      ok = "%mok2";
    }
    lines.push(`  br i1 ${ok}, label %mfast, label %mslow`, `mslow:`, ...call("ms"), `mfast:`);
    let buf = classId || compact ? String(PUB_LOG_COUNT) : "0";
    if (cyc) {
      // ScrCycHdr.buf, the word before the object: its top bit while the
      // object is a buffered candidate, and -1 (SCR_CYC_ACYCLIC) for an
      // object that never is one.
      this.host.declare(`declare i32 @scr_cyc_pub_take(ptr)`);
      lines.push(
        `  %mbufp = getelementptr inbounds i8, ptr %o, i64 -4`,
        `  %mbufw = load i32, ptr %mbufp`,
        `  %mfree = icmp sge i32 %mbufw, -1`,
        `  br i1 %mfree, label %mput, label %mtake`,
        `mtake:`,
        `  %mix = call i32 @scr_cyc_pub_take(ptr %o)`,
        `  %mix1 = add i32 %mix, 1`,
        ...field("mtaken", 7),
        `  %mtaken1 = add ${S} %mtaken, 1`,
        `  store ${S} %mtaken1, ptr %mtakenp`,
        ...(classId ? [`  %mix2 = or i32 %mix1, ${PUB_LOG_COUNT}`] : []),
        `  br label %mput`,
        `mput:`,
        `  %mbuf = phi i32 [ ${buf}, %mfast ], [ %mix${classId ? 2 : 1}, %mtake ]`,
      );
      buf = "%mbuf";
    }
    lines.push(
      `  %mlogp = getelementptr inbounds ptr, ptr %ctx, i32 3`,
      `  %mlog = load ptr, ptr %mlogp`,
      `  %me = getelementptr inbounds { ptr, i32, i32 }, ptr %mlog, ${S} %mlogged`,
      `  store ptr %o, ptr %me`,
      `  %merc = getelementptr inbounds { ptr, i32, i32 }, ptr %me, i32 0, i32 1`,
      C === "i64" ? `  %mrc32 = trunc i64 %mrc to i32` : `  %mrc32 = add i32 %mrc, 0`,
      `  store i32 %mrc32, ptr %merc`,
      `  %mebuf = getelementptr inbounds { ptr, i32, i32 }, ptr %me, i32 0, i32 2`,
      `  store i32 ${buf}, ptr %mebuf`,
      `  %mlogged1 = add ${S} %mlogged, 1`,
      `  store ${S} %mlogged1, ptr %mloggedp`,
      ...(compact
        ? [`  %mpub = or i32 %mrc, ${COMPACT_MARK}`, `  store i32 %mpub, ptr %o`]
        : [`  store ${C} -1, ptr %o`]),
      `  br label %walk`,
    );
    return lines;
  }

  /** Lines pushing the reference `v` with the walker `fn`. Null and
   * immortal references (the parent links of a tree, values published
   * before) are the ones scr_pub_push skips: they are tested here, without
   * the call. The lines end in a fresh block labelled `pushed${id}`. */
  private push(v: string, fn: string, id: string, compact = false): string[] {
    return [
      `  %null${id} = icmp eq ptr ${v}, null`,
      `  br i1 %null${id}, label %pushed${id}, label %live${id}`,
      `live${id}:`,
      // The count (the low half of a 64-bit rc word) is UINT32_MAX for an
      // immortal object of every kind (scr_rc.h SCR_RC_COUNT), and a
      // compact object's header word has its top bit set once published.
      `  %rc${id} = load i32, ptr ${v}`,
      compact
        ? `  %immortal${id} = icmp slt i32 %rc${id}, 0`
        : `  %immortal${id} = icmp eq i32 %rc${id}, -1`,
      `  br i1 %immortal${id}, label %pushed${id}, label %push${id}`,
      `push${id}:`,
      ...this.pushLines(v, fn, id),
      `  br label %pushed${id}`,
      `pushed${id}:`,
    ];
  }

  /** The push of a live, mortal `v`: strings are leaves, marked at once; any
   * other value goes on the worklist (ScrPub's leading `stack`, `len` and
   * `cap`, scr_publish.c), through scr_pub_push when the stack is full. */
  private pushLines(v: string, fn: string, id: string): string[] {
    if (fn === RUNTIME_WALKERS.string) return [`  call void ${fn}(ptr ${v}, ptr %ctx)`];
    const S = this.host.sizeType;
    return [
      `  %lenp${id} = getelementptr inbounds ptr, ptr %ctx, i32 1`,
      `  %len${id} = load ${S}, ptr %lenp${id}`,
      `  %capp${id} = getelementptr inbounds ptr, ptr %ctx, i32 2`,
      `  %cap${id} = load ${S}, ptr %capp${id}`,
      `  %full${id} = icmp eq ${S} %len${id}, %cap${id}`,
      `  br i1 %full${id}, label %grow${id}, label %room${id}`,
      `grow${id}:`,
      `  call void @scr_pub_push(ptr %ctx, ptr ${v}, ptr ${fn})`,
      `  br label %pushed${id}`,
      `room${id}:`,
      `  %stk${id} = load ptr, ptr %ctx`,
      `  %slot${id} = getelementptr inbounds { ptr, ptr }, ptr %stk${id}, ${S} %len${id}`,
      `  store ptr ${v}, ptr %slot${id}`,
      `  %slotfn${id} = getelementptr inbounds { ptr, ptr }, ptr %slot${id}, i32 0, i32 1`,
      `  store ptr ${fn}, ptr %slotfn${id}`,
      `  %lennext${id} = add ${S} %len${id}, 1`,
      `  store ${S} %lennext${id}, ptr %lenp${id}`,
    ];
  }

  /** Whether references of type `t` are compact class instances. */
  private compactRef(t: IrType): boolean {
    const arm = this.host.nullableArm(t) ?? t;
    return arm.kind === "object" && this.host.classInfo(arm.className).compact;
  }

  private objectBody(
    head: string,
    struct: string,
    traced: boolean,
    members: PublishClassInfo["fields"],
    path: string,
    loc: SrcLoc,
    classId = false,
    compact = false,
  ): string[] {
    const lines = [
      head,
      `entry:`,
      ...this.markLines(traced, PUB_KIND_OBJECT, classId, compact),
      `walk:`,
    ];
    let n = 0;
    for (const member of members) {
      const fn = this.walker(member.type, `${path}.${member.name}`, loc);
      if (fn === null) continue;
      if (scalarRefusal(member.type)) {
        // A scalar field (a date) always holds a value: refuse.
        lines.push(`  call void ${fn}(ptr null, ptr %ctx) ; ${llvmComment(member.name)}`);
        continue;
      }
      lines.push(
        `  %f${n} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${member.index} ; ${llvmComment(member.name)}`,
        ...(member.compressed === true
          ? [
              `  %v${n}.i = load i32, ptr %f${n}`,
              ...compactRefLoadLines(`%v${n}.i`, `%v${n}`, `%v${n}.d`),
            ]
          : [`  %v${n} = load ptr, ptr %f${n}`]),
        ...this.push(`%v${n}`, fn, `${n}`, this.compactRef(member.type)),
      );
      n++;
    }
    lines.push(`  br label %done`, `done:`, `  ret void`, `}`);
    return lines;
  }
}

/** Unpublishable types stored as scalars (process streams are file
 * descriptors): no pointer to push, and always a value. */
function scalarRefusal(t: IrType): boolean {
  return t.kind === "procStream";
}

/** The Node.js implementation's refusal for a value of type `t`. */
function refusalMessage(t: IrType): string {
  switch (t.kind) {
    case "func":
      return "Cannot publish a function";
    case "symbol":
      return "Cannot publish a symbol";
    case "regex":
      return "Cannot publish a RegExp object";
    case "date":
      return "Cannot publish a Date object";
    case "promise":
      return "Cannot publish a Promise object";
    case "bytes":
      return `Cannot publish a ${BYTES_NAMES[t.elem] ?? "Uint8Array"} object`;
    default:
      return "Cannot publish this value";
  }
}

const BYTES_NAMES: Record<string, string> = {
  u8: "Uint8Array",
  u8c: "Uint8ClampedArray",
  i8: "Int8Array",
  u16: "Uint16Array",
  i16: "Int16Array",
  u32: "Uint32Array",
  i32: "Int32Array",
  f32: "Float32Array",
  f64: "Float64Array",
};

function llvmComment(text: string): string {
  return text.replace(/[\r\n]/g, " ");
}
