import { InternalCompilerError } from "../../errors.js";
/** Class layouts, reference counting, hierarchy intervals, virtual tables and
 * constructor values. Opaque LLVM pointers allow virtual slots to store method
 * implementations directly. Runtime EventEmitter and stream subclasses embed
 * their runtime prefixes ahead of user fields. */
import type { IrClassDef, IrFunction, IrModule, IrType, IrUnionDef } from "../../ir/ir.js";
import {
  isRefCounted,
  RUNTIME_EMITTER_CLASS,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_STREAM_CLASSES,
  classValueConstructor,
} from "../../ir/ir.js";
import { streamRooted, undefinedArmTag } from "../../ir/analysis.js";
import {
  mangleClassGcFree,
  mangleClassNew,
  mangleClassObj,
  mangleClassRelease,
  mangleClassReleaseDirect,
  mangleClassRetain,
  mangleClassStruct,
  mangleClassTrace,
  mangleCtorThunk,
  mangleFunction,
  mangleGlobal,
  mangleVtArray,
  mangleVtInstance,
  mangleVtStruct,
} from "../mangle.js";
import { cycTypeDescriptor, emitObjectAlloc, emitObjectFree } from "./alloc.js";
import { llvmCommentText } from "./common.js";
import { INLINE_UNION_FIELD } from "./inline-unions.js";
import { NullableRefFields } from "./nullable-fields.js";
import type { Int32Slots } from "../../ir/int32-slots.js";
import {
  cycleRootLines,
  traceFieldVisitLines,
  FN_ATTRS,
  cycleDeadLines,
  destroyDefinitions,
  directChildReleaseLines,
  directDestroyTarget,
  segmentPrologueLines,
  segmentTeardownLines,
  segmentedTeardown,
  usedDirectTargets,
  type DirectDestroy,
  type RegionHooks,
  llFieldType,
  releaseBody,
  releaseFastPath,
  needsBoundedRelease,
  releaseSym,
  retainBody,
  traceAdapter,
  type ShapeHost,
  youngEntryLines,
  arrElemInit,
} from "./shapes.js";

/** One virtual method slot of a hierarchy: the ROOT-MOST declaring class
 * owns the slot; its declaration's IrFunction fixes the slot's ABI (the
 * frontend's override exactness makes every implementation identical). */
export interface LlVtSlot {
  method: string;
  declarer: LlClassMeta;
  fn: IrFunction;
}

/** Per-class node of the class graph. */
export class LlClassMeta {
  base: LlClassMeta | null = null;
  children: LlClassMeta[] = [];
  root: LlClassMeta;
  pre = 0;
  post = 0;
  hierarchy = false;
  /** Root classes: the hierarchy's slots in DFS-declaration order. */
  slots: LlVtSlot[] = [];
  membership: { pre: number; post: number }[] = [];
  /** Type-only references retain layouts without retaining construction. */
  constructorRetained = false;
  /** The hierarchy holds ThreadSlots keys (IrModule.threadSlotKeys): every
   * member's struct carries the i32 slot word before its fields
   * (classSlotWordIndex). */
  threadSlot = false;
  /** A member of a program-rooted hierarchy on a 64-bit target: instead of
   * a vtable word, the rc word holds the class id (classIdRcWord) in its
   * high 32 bits (CLASS_ID_OFFSET) and the reference count in its low 32
   * bits, and the hierarchy's vtables are one array indexed by the id
   * (mangleVtArray). */
  idInRc = false;
  /** A ProgramLifetime class with the 32-bit header (assignCompactLayouts):
   * the i32 at offset 0 is compactHeaderWord, with the class id in place of
   * the rc word's high half, and the fields are packed after it. */
  compact = false;
  /** Compact classes: the struct's elements by offset (the header, field
   * -1, then the fields by their index in def.fields). */
  compactElems: { offset: number; size: number; align: number; type: string; field: number }[] = [];
  /** Compact classes: each field's GEP index, by its index in def.fields. */
  compactSlots: number[] = [];
  /** Compact classes: whether each field (by its index in def.fields) holds
   * a compact class instance as a 32-bit index (COMPACT_REF) rather than a
   * pointer: compactRefLoadLines decodes it, compactRefStoreLines encodes it. */
  compressed: boolean[] = [];

  constructor(readonly def: IrClassDef) {
    this.root = this;
  }
}

/** The class graph: link base/children, number the forest in preorder
 * (roots and children in module class order, matching the
 * runtime's stamped error vtables), and compute each hierarchy's virtual
 * slots — a class's method gets a slot iff no ancestor declares it AND some
 * strict descendant redeclares it (whole-program devirtualization).
 * The preorder intervals also identify runtime class membership. */
export function buildClassGraph(
  mod: IrModule,
  fnByName: Map<string, IrFunction>,
  sizeType: "i32" | "i64" = "i64",
): Map<string, LlClassMeta> {
  const metaMap = new Map<string, LlClassMeta>();
  for (const cls of mod.classes ?? []) {
    const meta = new LlClassMeta(cls);
    meta.constructorRetained = fnByName.has(`%${cls.name}.constructor`);
    metaMap.set(cls.name, meta);
  }
  for (const meta of metaMap.values()) {
    if (meta.def.base === undefined) continue;
    const base = metaMap.get(meta.def.base);
    if (!base)
      throw new InternalCompilerError(`llvm emitter bug: undeclared base class ${meta.def.base}`);
    meta.base = base;
    base.children.push(meta);
  }
  let preCounter = 0;
  const number = (meta: LlClassMeta, root: LlClassMeta): void => {
    meta.root = root;
    meta.pre = preCounter++;
    for (const c of meta.children) number(c, root);
    meta.post = preCounter - 1;
  };
  for (const meta of metaMap.values()) {
    if (meta.base === null) number(meta, meta);
    meta.hierarchy = meta.base !== null || meta.children.length > 0;
  }
  // The runtime reads the vtable word of runtime-rooted hierarchies (Error,
  // EventEmitter, EventTarget, Event and the streams) and 32-bit targets
  // have no spare half in the rc word: those keep the vtable word.
  for (const meta of metaMap.values())
    meta.idInRc = sizeType === "i64" && meta.hierarchy && meta.root.def.runtime !== true;
  const slotRoots = new Set<LlClassMeta>();
  for (const key of mod.threadSlotKeys ?? []) {
    const meta = metaMap.get(key);
    if (meta !== undefined) slotRoots.add(meta.root);
  }
  for (const meta of metaMap.values()) meta.threadSlot = slotRoots.has(meta.root);
  const declares = (m: LlClassMeta, method: string): boolean =>
    m.def.methods?.includes(method) ?? false;
  const declaredBelow = (m: LlClassMeta, method: string): boolean =>
    m.children.some((c) => declares(c, method) || declaredBelow(c, method));
  const collectSlots = (m: LlClassMeta, root: LlClassMeta): void => {
    for (const method of m.def.methods ?? []) {
      let inherited = false;
      for (let a = m.base; a; a = a.base) inherited = inherited || declares(a, method);
      if (!inherited && declaredBelow(m, method)) {
        let fn = fnByName.get(`%${m.def.name}.${method}`);
        if (!fn && m.def.abstractMethods?.includes(method)) {
          // Abstract declarer: the slot ABI comes from any concrete
          // descendant implementation; none anywhere means the slot can
          // never dispatch (only abstract classes declare it) — skip.
          const findImpl = (c: LlClassMeta): IrFunction | undefined => {
            for (const child of c.children) {
              const f =
                declares(child, method) && !child.def.abstractMethods?.includes(method)
                  ? fnByName.get(`%${child.def.name}.${method}`)
                  : undefined;
              const found = f ?? findImpl(child);
              if (found) return found;
            }
            return undefined;
          };
          fn = findImpl(m);
          if (!fn) continue;
        }
        if (!fn)
          throw new InternalCompilerError(
            `llvm emitter bug: missing method function %${m.def.name}.${method}`,
          );
        root.slots.push({ method, declarer: m, fn });
      }
    }
    for (const c of m.children) collectSlots(c, root);
  };
  for (const meta of metaMap.values()) {
    if (meta.base === null && meta.hierarchy) collectSlots(meta, meta);
  }
  // Precompute nominal membership once. Each concrete layout contributes
  // to its own ancestry and to the erased families along that ancestry.
  for (const member of [...metaMap.values()].sort((a, b) => a.pre - b.pre)) {
    const targets = new Set<LlClassMeta>();
    for (let current: LlClassMeta | null = member; current; current = current.base) {
      targets.add(current);
      for (
        let family: LlClassMeta | undefined = current.def.genericOf
          ? metaMap.get(current.def.genericOf)
          : undefined;
        family;
        family = family.base ?? undefined
      )
        targets.add(family);
    }
    for (const target of targets) {
      const previous = target.membership[target.membership.length - 1];
      if (previous && previous.post + 1 === member.pre) previous.post = member.pre;
      else target.membership.push({ pre: member.pre, post: member.pre });
    }
  }
  return metaMap;
}

/** Family identity may span several concrete base subtrees. Keep those
 * ranges separate from the physical layout graph used by virtual calls. */
export function classMembershipIntervals(
  classes: ReadonlyMap<string, LlClassMeta>,
  targetName: string,
): { pre: number; post: number }[] {
  const target = classes.get(targetName);
  if (!target) throw new InternalCompilerError(`undeclared class ${targetName}`);
  return target.membership;
}

/** Runtime class-value tests normally use one interval. Only generic
 * families with disjoint storage subtrees require this shared dispatch. */
export function emitClassMembershipHelper(
  classes: ReadonlyMap<string, LlClassMeta>,
  sizeType: string,
): string[] {
  const families = [...classes.values()].filter(
    (meta) => classMembershipIntervals(classes, meta.def.name).length > 1,
  );
  if (!families.length) return [];
  const lines = [
    `define internal i1 @sc_class_membership(${sizeType} %value, ${sizeType} %pre, ${sizeType} %post) alwaysinline {`,
    `entry:`,
    `  switch ${sizeType} %pre, label %ordinary [`,
    ...families.map((family, index) => `    ${sizeType} ${family.pre}, label %family${index}`),
    `  ]`,
  ];
  families.forEach((family, index) => {
    lines.push(`family${index}:`);
    const ranges = classMembershipIntervals(classes, family.def.name);
    ranges.forEach((range, ordinal) => {
      const prefix = `f${index}_${ordinal}`;
      lines.push(
        `  %${prefix}lo = icmp uge ${sizeType} %value, ${range.pre}`,
        `  %${prefix}hi = icmp ule ${sizeType} %value, ${range.post}`,
        `  %${prefix}match = and i1 %${prefix}lo, %${prefix}hi`,
      );
      if (ordinal)
        lines.push(
          `  %${prefix}any = or i1 %f${index}_${ordinal - 1}${ordinal === 1 ? "match" : "any"}, %${prefix}match`,
        );
    });
    lines.push(`  ret i1 %f${index}_${ranges.length - 1}${ranges.length === 1 ? "match" : "any"}`);
  });
  lines.push(
    `ordinary:`,
    `  %lo = icmp uge ${sizeType} %value, %pre`,
    `  %hi = icmp ule ${sizeType} %value, %post`,
    `  %result = and i1 %lo, %hi`,
    `  ret i1 %result`,
    `}`,
    ``,
  );
  return lines;
}

/** The root's slot list as seen by one class: the implementation the class
 * dispatches to, or null outside the slot's declaring subtree / on a
 * fully-abstract chain (vtEntriesFor, ported). */
export function vtEntriesFor(meta: LlClassMeta): { slot: LlVtSlot; impl: LlClassMeta | null }[] {
  return meta.root.slots.map((slot): { slot: LlVtSlot; impl: LlClassMeta | null } => {
    if (!(slot.declarer.pre <= meta.pre && meta.pre <= slot.declarer.post)) {
      return { slot, impl: null };
    }
    for (let c: LlClassMeta | null = meta; c; c = c.base) {
      if (c.def.methods?.includes(slot.method) && !c.def.abstractMethods?.includes(slot.method)) {
        return { slot, impl: c };
      }
    }
    if (meta.def.abstract === true || !meta.constructorRetained) return { slot, impl: null };
    throw new InternalCompilerError(
      `llvm emitter bug: no implementation of ${slot.method} for ${meta.def.name}`,
    );
  });
}

/** The LLVM struct type name a class's instances GEP through: the runtime
 * error classes share the runtime's ScrError layout (emitted subclasses
 * embed it as their prefix); every emitted class has its own %sc_o_*. */
export function classStructSym(className: string): string {
  if (RUNTIME_ERROR_CLASSES.has(className)) return "ScrError";
  if (className === RUNTIME_EMITTER_CLASS) return "ScrEmitter";
  if (className === RUNTIME_EVENT_TARGET_CLASS) return "ScrEventTargetObj";
  if (className === RUNTIME_EVENT_CLASS) return "ScrEventObj";
  if (RUNTIME_STREAM_CLASSES.has(className)) return "ScrStream";
  return mangleClassStruct(className);
}

/** A runtime base whose prefix emitted subclasses embed after the vtable
 * word: the state pointer at 2 (NULL in a fresh allocation) and the
 * display-name slot at 3, then the subclass fields. The entries are the
 * runtime's helpers for the state pointer: the teardown's drop, the
 * collector's trace and its gcFree. */
interface RuntimePrefix {
  struct: string;
  what: string;
  drop: string;
  trace: string;
  gcFree: string;
}

const RUNTIME_PREFIXES: ReadonlyMap<string, RuntimePrefix> = new Map([
  [
    RUNTIME_EMITTER_CLASS,
    {
      struct: "ScrEmitter",
      what: "EventEmitter prefix",
      drop: "scr_emitter_reg_drop",
      trace: "scr_emitter_reg_trace",
      gcFree: "scr_emitter_reg_gcfree",
    },
  ],
  [
    RUNTIME_EVENT_TARGET_CLASS,
    {
      struct: "ScrEventTargetObj",
      what: "EventTarget prefix",
      drop: "scr_event_target_state_drop",
      trace: "scr_event_target_state_trace",
      gcFree: "scr_event_target_state_gcfree",
    },
  ],
  [
    RUNTIME_EVENT_CLASS,
    {
      struct: "ScrEventObj",
      what: "Event prefix",
      drop: "scr_event_state_drop",
      trace: "scr_event_state_trace",
      gcFree: "scr_event_state_gcfree",
    },
  ],
]);

/** The runtime prefix a class's struct embeds (its hierarchy root is the
 * emitter, EventTarget or Event), so an upcast to the runtime struct is
 * the usual pointer reinterpret (shapes.ts's rule); null otherwise. */
function runtimePrefixOf(meta: LlClassMeta): RuntimePrefix | null {
  if (!meta.hierarchy) return null;
  return RUNTIME_PREFIXES.get(meta.root.def.name) ?? null;
}

/** The GEP index after a class's header words: rc at 0, the vtable word
 * at 1 on hierarchy members that do not keep their class id in the rc
 * word (LlClassMeta.idInRc), then a runtime prefix (state + display name)
 * on classes rooted at a runtime base, then the stream-state slot on
 * stream-rooted ones. */
function headerEnd(meta: LlClassMeta): number {
  if (meta.def.arrayElem !== undefined) return ARRAY_PREFIX.length + 1;
  if (!meta.hierarchy || meta.idInRc) return 1;
  if (streamRooted(meta)) return 5;
  return runtimePrefixOf(meta) ? 4 : 2;
}

/** The array header a class declared `extends Array` begins with, after
 * the size_t reference count: %ScrArr's len, cap, elem, cyc, spare, filled
 * and data (scr_array.h). */
const ARRAY_PREFIX = ["i32", "i32", "i8", "i8", "i16", "i32", "ptr"];

/** LLVM `c"..."` text of a string's UTF-8 bytes and a terminating NUL. */
function nulTerminatedBytes(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8"))
    out +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\${byte.toString(16).padStart(2, "0").toUpperCase()}`;
  return out + "\\00";
}

/** The class descriptor (ScrArrClass: name, destroy) of a class declared
 * `extends Array`. */
export function arrayClassDescriptor(className: string): string {
  return `@${mangleClassStruct(className)}.arrcls`;
}

/** The GEP index of the ThreadSlots slot word (an i32) in a class whose
 * hierarchy holds ThreadSlots keys: right after the header words, so every
 * member of the hierarchy has it at the same offset. */
export function classSlotWordIndex(meta: LlClassMeta): number {
  if (!meta.threadSlot)
    throw new InternalCompilerError(`llvm emitter bug: class ${meta.def.name} has no slot word`);
  return headerEnd(meta);
}

/** The GEP index where a class's own fields start: after the header words
 * and the slot word. */
export function classFieldBase(meta: LlClassMeta): number {
  if (meta.compact)
    throw new InternalCompilerError(
      `llvm emitter bug: compact class ${meta.def.name} packs its fields`,
    );
  return headerEnd(meta) + (meta.threadSlot ? 1 : 0);
}

/** Append the lexical environment after inherited fields to preserve base layouts. */
export function classEnvironmentIndex(meta: LlClassMeta): number {
  return classFieldIndex(meta, `%classEnvironment:${meta.def.name}`).index;
}

/** A field's GEP index inside its class struct: rc at 0, the vtable word
 * at 1 on hierarchy members, then the flattened field list. */
export function classFieldIndex(
  meta: LlClassMeta,
  field: string,
  refs: "pointer" | "compressed" = "pointer",
): { index: number; type: IrType; compressed: boolean } {
  const idx = meta.def.fields.findIndex((f) => f.name === field);
  if (idx < 0)
    throw new InternalCompilerError(
      `llvm emitter bug: unknown field ${field} on class ${meta.def.name}`,
    );
  const compressed = meta.compressed[idx] === true;
  // Callers that read or write a field's storage as a pointer must not see
  // a compressed one; callers that decode and encode pass "compressed".
  if (compressed && refs === "pointer")
    throw new InternalCompilerError(
      `llvm emitter bug: field ${field} of ${meta.def.name} holds a 32-bit reference`,
    );
  return { index: classFieldSlot(meta, idx), type: meta.def.fields[idx]!.type, compressed };
}

/** The GEP index of the field at `idx` in `meta.def.fields`. */
export function classFieldSlot(meta: LlClassMeta, idx: number): number {
  return meta.compact ? meta.compactSlots[idx]! : classFieldBase(meta) + idx;
}

/** Lines that release the ThreadSlots values of the object `%o` before it
 * is freed: its slot word is 0 unless a value was ever set for it. */
function slotForgetLines(
  host: ClassHost,
  struct: string,
  meta: LlClassMeta,
  tag: string,
): string[] {
  host.declare(`declare void @scr_slots_forget(i32)`);
  return [
    `  %${tag}p = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${classSlotWordIndex(meta)}`,
    `  %${tag} = load i32, ptr %${tag}p, align 4`,
    `  %${tag}.set = icmp ne i32 %${tag}, 0`,
    `  br i1 %${tag}.set, label %${tag}.forget, label %${tag}.done`,
    `${tag}.forget: ; release its ThreadSlots values`,
    `  call void @scr_slots_forget(i32 %${tag})`,
    `  br label %${tag}.done`,
    `${tag}.done:`,
  ];
}

/** What class emission needs beyond ShapeHost: interned unit instances for
 * undefined-admitting field initialization (fields typed by an
 * undefined-armed union start as JS's `undefined`, never NULL), and the
 * interned NUL-terminated constants (emitter subclass display names). */
export interface ClassHost extends ShapeHost {
  readonly unionsById: Map<string, IrUnionDef>;
  unitInstanceRef(unionId: string, tag: number): string;
  cstr(text: string): string;
  /** The symbol a vtable stores for a method implementation (its owned
   * entry point unless the slot's calling convention borrows; see
   * LlEmitter.virtualEntry). */
  virtualEntry?(implFn: string): string;
  /** Roots of the hierarchies declared `implements ProgramLifetime`
   * (IrContracts.programLifetime). Absent: none. */
  readonly programLifetime?: ReadonlySet<string>;
}

/** Whether `meta`'s instances live until the process exits (a
 * ProgramLifetime hierarchy, contracts/check.ts): `new` allocates them
 * without a collector header and with the reference count
 * programLifetimeRc, nothing frees them, and the class's retain and release
 * entry points are empty, so reference counting on any static type of the
 * hierarchy folds away. The cycle analysis leaves the hierarchy untraced, so
 * no trace adapter ever visits an instance (as for every untraced class). */
export function programLifetimeClass(host: ClassHost, meta: LlClassMeta): boolean {
  return (
    host.programLifetime?.has(meta.root.def.name) === true &&
    meta.root.def.runtime !== true &&
    meta.root.def.arrayElem === undefined
  );
}

/** The reference count a program-lifetime instance is created with: the
 * midpoint of the size_t range (2^63, or 2^31 on 32-bit targets).
 *
 * SIZE_MAX would also keep the object alive, but every runtime contract
 * reads rc == SIZE_MAX as "published": immutable (the frozen-object guards
 * throw on stores), shareable by pointer (postMessage and workerData deliver
 * it without a clone) and already walked (publication stops there). A
 * program-lifetime object is none of these until the program publishes it;
 * it is mutable and owned by the thread that made it. Publication then marks
 * it SIZE_MAX like any other object it reaches (and restores this count when
 * a refusal undoes the publish), so the count doubles as the published and
 * visited mark without a header or an extra word.
 *
 * Only the class's empty helpers count references on these types, so any
 * count away from 0, 1 and SIZE_MAX would do; the midpoint keeps even an
 * unpaired generic retain or release from ever reaching either end. */
export function programLifetimeRc(sizeType: "i32" | "i64"): string {
  return sizeType === "i32" ? "-2147483648" : "-9223372036854775808";
}

/** Lines that load the preorder number of the dynamic class of `obj`, an
 * instance of `meta`'s hierarchy whose struct is `struct`, into `pre` (a
 * `sizeType`): from the high half of the rc word (LlClassMeta.idInRc), or
 * from the vtable its vtable word points at. */
export function classPreLines(
  meta: LlClassMeta,
  struct: string,
  obj: string,
  pre: string,
  sizeType: "i32" | "i64",
): string[] {
  if (meta.idInRc)
    return [
      ...classIdLoadLines(meta, obj, `${pre}.id`, ""),
      `  ${pre}.n = add i32 ${pre}.id, -1 ; the class id is the preorder number + 1`,
      `  ${pre} = zext i32 ${pre}.n to ${sizeType}`,
    ];
  return [
    `  ${pre}.vtp = getelementptr inbounds %${struct}, ptr ${obj}, i64 0, i32 1`,
    `  ${pre}.vt = load ptr, ptr ${pre}.vtp`,
    `  ${pre}.prep = getelementptr inbounds %ScrVt, ptr ${pre}.vt, i64 0, i32 0`,
    `  ${pre} = load ${sizeType}, ptr ${pre}.prep`,
  ];
}

/** Lines that load the class id of the LlClassMeta.idInRc instance `obj`
 * (`group` adds !invariant.group to the load) and point `vt` at its class's
 * element of the hierarchy's vtable array. */
export function classIdVtLines(
  meta: LlClassMeta,
  obj: string,
  vt: string,
  group: string,
): string[] {
  const t = `${vt}.`;
  const root = meta.root;
  const vtt = `%${mangleVtStruct(root.def.name)}`;
  const n = root.post - root.pre + 1;
  return [
    ...classIdLoadLines(meta, `${obj}`, `${t}id`, group),
    `  ${t}ix = sub i32 ${t}id, ${root.pre + 1}`,
    `  ${t}ix64 = zext i32 ${t}ix to i64`,
    `  ${vt} = getelementptr inbounds [${n} x ${vtt}], ptr @${mangleVtArray(root.def.name)}, i64 0, i64 ${t}ix64`,
  ];
}

/** Lines that load the class id of the LlClassMeta.idInRc instance `obj`
 * into the i32 `id`: the high half of the rc word, or the low 28 bits of a
 * compact instance's header word (compactHeaderWord). `group` is the
 * metadata of the load (`, !invariant.group !{}` for a load LLVM may treat
 * as invariant), and it only goes on bytes that never change: publication
 * sets the top bit of a compact header word, so a compact instance's id is
 * then read as the word's low 16 bits, which hold the whole id when the
 * hierarchy's ids are below 2^16, and otherwise as the masked word without
 * the metadata. */
export function classIdLoadLines(
  meta: LlClassMeta,
  obj: string,
  id: string,
  group: string,
): string[] {
  if (meta.compact) {
    if (group !== "" && meta.root.post + 1 <= 0xffff)
      return [`  ${id}.h = load i16, ptr ${obj}${group}`, `  ${id} = zext i16 ${id}.h to i32`];
    return [`  ${id}.w = load i32, ptr ${obj}`, `  ${id} = and i32 ${id}.w, ${COMPACT_ID_MASK}`];
  }
  return [
    `  ${id}p = getelementptr inbounds i8, ptr ${obj}, i64 ${CLASS_ID_OFFSET}`,
    `  ${id} = load i32, ptr ${id}p${group}`,
  ];
}

/** The byte offset of the class id in the rc word of an instance that
 * keeps it there (LlClassMeta.idInRc): the high half of the little-endian
 * 64-bit word. The count is the i32 at offset 0. */
export const CLASS_ID_OFFSET = 4;

/** The rc word an LlClassMeta.idInRc instance is created with: the class
 * id, its preorder number plus 1, in the high 32 bits, and in the low 32 bits
 * a count of 1, or for a program-lifetime instance the midpoint of the 32-bit
 * count (as programLifetimeRc is of the 32-bit word). The id is never 0,
 * 0x80000000 or 0xffffffff, the high halves of other objects' rc words, so
 * the runtime can tell an object with a class id (scr_rc.h scr_rc_class_id). */
export function classIdRcWord(meta: LlClassMeta, lifetime: boolean): string {
  return (BigInt(meta.pre + 1) * 2n ** 32n + (lifetime ? 2n ** 31n : 1n)).toString();
}

/** The 32-bit header of a compact class instance (LlClassMeta.compact):
 * COMPACT_HEADER_TAG, the class id (classIdRcWord's preorder number + 1, 0
 * outside a hierarchy) in the low 28 bits, and COMPACT_PUBLISHED once
 * publication marks the object. No other object's count reaches
 * 0x70000000, so the runtime reads a word of 0xf0000000 and up as published
 * for every object (scr_rc.h SCR_RC_PUBLISHED). */
export const COMPACT_HEADER_TAG = 0x70000000;
export const COMPACT_PUBLISHED = 0x80000000;
export const COMPACT_ID_MASK = 0x0fffffff;

/** The leading bytes of a new instance that its allocation function stores
 * right after allocating it (emitObjectAlloc's `stored`), which a recycled
 * block therefore need not clear: a compact instance's 4-byte header word
 * (its fields start at offset 4), the 8-byte rc word, or the rc word and
 * the vtable word of a hierarchy member that keeps its class in a vtable. */
export function storedHeaderBytes(meta: LlClassMeta): number {
  if (meta.compact) return 4;
  return meta.hierarchy && !meta.idInRc ? 16 : 8;
}

/** The header word a compact instance is created with. */
export function compactHeaderWord(meta: LlClassMeta): number {
  return COMPACT_HEADER_TAG | (meta.hierarchy ? meta.pre + 1 : 0);
}

/** Lines that decode the 32-bit reference `idx` (an i32) of a compressed
 * field into the pointer `out`. The program-lifetime region lies below
 * 32 GiB (LlvmTargetOptions.lowRegion), so a reference is the instance's
 * address over 8 and 0 is NULL: one shift, which x86-64 folds into the
 * address of the next load. `t` names the temporaries. */
export function compactRefLoadLines(idx: string, out: string, t: string): string[] {
  return [
    `  ${t}.z = zext i32 ${idx} to i64`,
    `  ${t}.o = shl nuw nsw i64 ${t}.z, 3`,
    `  ${out} = inttoptr i64 ${t}.o to ptr`,
  ];
}

/** Lines that encode the pointer `ptr` (NULL or a compact class instance)
 * as the 32-bit reference `out` (an i32) a compressed field stores. */
export function compactRefStoreLines(ptr: string, out: string, t: string): string[] {
  return [
    `  ${t}.pi = ptrtoint ptr ${ptr} to i64`,
    `  ${t}.s = lshr i64 ${t}.pi, 3`,
    `  ${out} = trunc i64 ${t}.s to i32`,
  ];
}

/** The storage type of a compressed field (LlClassMeta.compressed): a
 * 32-bit index into the program-lifetime region. */
export const COMPACT_REF = "i32";

/** Lines that allocate `%o`, `size` zeroed bytes in the program-lifetime
 * region: a bump of the calling thread's chunk (scr_rc.h ScrPlrChunk,
 * thread-local in worker programs), and scr_plr_alloc when the chunk is
 * exhausted or the target has no inline allocation. The lines end in an
 * open block. */
function plrAllocLines(host: ClassHost, size: string): string[] {
  const S = host.sizeType;
  host.declare(`declare ptr @scr_plr_alloc(${S})`);
  host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
  if (host.inlineAlloc !== true) return [`  %o = call ptr @scr_plr_alloc(${S} ${size})`];
  const chunk: string[] = [];
  if (host.threadLocalAlloc === true) {
    host.declare(`@scr_plr_chunk = external thread_local global { ptr, ptr }`);
    host.declare(`declare nonnull ptr @llvm.threadlocal.address.p0(ptr nonnull)`);
    chunk.push(`  %plr.c = call ptr @llvm.threadlocal.address.p0(ptr @scr_plr_chunk)`);
  } else {
    host.declare(`@scr_plr_chunk = external dso_local global { ptr, ptr }`);
    chunk.push(`  %plr.c = getelementptr inbounds i8, ptr @scr_plr_chunk, i64 0`);
  }
  // A thread without a chunk has NULL for both, so nothing fits.
  return [
    ...chunk,
    `  %plr.lp = getelementptr inbounds i8, ptr %plr.c, i64 8`,
    `  %plr.next = load ptr, ptr %plr.c`,
    `  %plr.lim = load ptr, ptr %plr.lp`,
    `  %plr.n7 = add ${S} ${size}, 7`,
    `  %plr.n = and ${S} %plr.n7, -8`,
    `  %plr.end = getelementptr i8, ptr %plr.next, ${S} %plr.n`,
    `  %plr.fits = icmp ule ptr %plr.end, %plr.lim`,
    `  %plr.fitsx = call i1 @llvm.expect.i1(i1 %plr.fits, i1 true)`,
    `  br i1 %plr.fitsx, label %plr.bump, label %plr.slow`,
    `plr.bump:`,
    `  store ptr %plr.end, ptr %plr.c`,
    `  br label %plr.done`,
    `plr.slow:`,
    `  %plr.o = call ptr @scr_plr_alloc(${S} ${size})`,
    `  br label %plr.done`,
    `plr.done:`,
    `  %o = phi ptr [ %plr.next, %plr.bump ], [ %plr.o, %plr.slow ]`,
  ];
}

/** Byte size and alignment of a class field's LLVM storage type. */
function fieldStorage(type: string): { size: number; align: number } {
  switch (type) {
    case "i8":
      return { size: 1, align: 1 };
    case "i32":
      return { size: 4, align: 4 };
    case "ptr":
    case "double":
      return { size: 8, align: 8 };
    case INLINE_UNION_FIELD:
      return { size: 16, align: 8 };
    default:
      throw new InternalCompilerError(`llvm emitter bug: class field storage ${type}`);
  }
}

/** The LLVM storage type of each of a class's flattened fields. */
export function classFieldTypes(host: ShapeHost, cls: IrClassDef, int32?: Int32Slots): string[] {
  // Whole-program int32 fields (int32-slots.ts) store the exact i32.
  return cls.fields.map((f) =>
    int32?.isField(cls.name, f.name)
      ? "i32"
      : llFieldType(f.type, host.inlineUnions.classField(cls.name, f.name)),
  );
}

/** Gives the classes `compact` admits (whole hierarchies: the test is the
 * root's) the 32-bit header and packed fields. A class keeps its base's
 * field offsets, and places each of its own fields at the first offset
 * after the header that fits it: in a hole another field's alignment left,
 * in the base's tail padding, or at the end. Scalars narrower than 8 bytes
 * (flags, ids, counts) go first, widest first, so they share the header's
 * cache line; then the other fields, widest first. So 32-bit and smaller
 * fields share 8-byte words. The struct lists the header and the fields by
 * offset, which LLVM's layout of the type reproduces (checked). */
export function assignCompactLayouts(
  metaMap: ReadonlyMap<string, LlClassMeta>,
  compact: (root: LlClassMeta) => boolean,
  fieldTypes: (cls: IrClassDef) => string[],
  compressedRef?: (
    cls: IrClassDef,
    field: number,
    isCompact: (className: string) => boolean,
  ) => boolean,
): void {
  const isCompact = (className: string): boolean => {
    const target = metaMap.get(className);
    return (
      target !== undefined &&
      target.def.runtime !== true &&
      target.root.def.arrayElem === undefined &&
      compact(target.root)
    );
  };
  const byPre = [...metaMap.values()].sort((a, b) => a.pre - b.pre);
  for (const meta of byPre) {
    if (meta.def.runtime === true || !compact(meta.root)) continue;
    const base = meta.base;
    const inherited = base?.compactElems ?? [
      { offset: 0, size: 4, align: 4, type: "i32", field: -1 },
    ];
    const baseCount = base?.def.fields.length ?? 0;
    if (base !== null && (!base.compact || !sameFieldPrefix(base.def, meta.def)))
      throw new InternalCompilerError(
        `llvm emitter bug: compact class ${meta.def.name} does not extend its base's layout`,
      );
    const elems = inherited.map((e) => ({ ...e }));
    // A reference to a compact class instance is a 32-bit index into the
    // program-lifetime region (compactRefLoadLines); inherited fields keep the
    // base's choice.
    const compressed = meta.def.fields.map((_, i) =>
      i < baseCount
        ? base!.compressed[i]!
        : compressedRef !== undefined && compressedRef(meta.def, i, isCompact),
    );
    const types = fieldTypes(meta.def).map((t, i) => {
      if (!compressed[i]) return t;
      if (t !== "ptr")
        throw new InternalCompilerError(
          `llvm emitter bug: compressed field ${meta.def.fields[i]!.name} of ${meta.def.name} is stored as ${t}`,
        );
      return COMPACT_REF;
    });
    const smallScalar = (f: { type: string; field: number; size: number }): number =>
      f.size < 8 && f.type !== "ptr" && !compressed[f.field] ? 0 : 1;
    const own = types
      .map((type, field) => ({ type, field, ...fieldStorage(type) }))
      .slice(baseCount)
      .sort((a, b) => smallScalar(a) - smallScalar(b) || b.size - a.size || a.field - b.field);
    for (const f of own) {
      const sorted = [...elems].sort((a, b) => a.offset - b.offset);
      let at = -1;
      let cursor = 0;
      for (const e of sorted) {
        const start = alignTo(cursor, f.align);
        if (start + f.size <= e.offset) {
          at = start;
          break;
        }
        cursor = Math.max(cursor, e.offset + e.size);
      }
      if (at < 0) at = alignTo(cursor, f.align);
      elems.push({ offset: at, size: f.size, align: f.align, type: f.type, field: f.field });
    }
    elems.sort((a, b) => a.offset - b.offset);
    // LLVM places each element at the next offset its alignment allows.
    let end = 0;
    for (const e of elems) {
      if (alignTo(end, e.align) !== e.offset)
        throw new InternalCompilerError(
          `llvm emitter bug: compact layout of ${meta.def.name} is not LLVM's`,
        );
      end = e.offset + e.size;
    }
    const slots = new Array<number>(types.length).fill(-1);
    elems.forEach((e, index) => {
      if (e.field >= 0) slots[e.field] = index;
    });
    meta.compact = true;
    meta.compactElems = elems;
    meta.compactSlots = slots;
    meta.compressed = compressed;
  }
}

function alignTo(n: number, align: number): number {
  return Math.ceil(n / align) * align;
}

function sameFieldPrefix(base: IrClassDef, cls: IrClassDef): boolean {
  return (
    base.fields.length <= cls.fields.length &&
    base.fields.every((f, i) => cls.fields[i]!.name === f.name)
  );
}

function undefFieldInits(
  host: ClassHost,
  meta: LlClassMeta,
  nullable: NullableRefFields | undefined,
): string[] {
  const out: string[] = [];
  meta.def.fields.forEach((f, i) => {
    // Error.cause uses NULL for absence; an options constructor installs
    // a value only when the cause property is present.
    if (f.name === "%cause") return;
    // A nullable-pointer field's zeroed slot already is its unit arm.
    if (nullable?.get(meta.def.name, f.name)) return;
    // Only union and dyn fields get a store here; a compressed field is a
    // class reference, which starts NULL.
    const { index, compressed } = classFieldIndex(meta, f.name, "compressed");
    if (compressed) return;
    if (f.type.kind === "union" && host.inlineUnions.classField(meta.def.name, f.name)) {
      // An inline field starts at the undefined arm's tag with zero bits.
      const tag = undefinedArmTag(f.type, host.unionsById);
      if (tag < 0) return;
      out.push(
        `  %uf${i} = getelementptr inbounds %${mangleClassStruct(meta.def.name)}, ptr %o, i64 0, i32 ${index}, i32 0`,
        `  store i32 ${tag}, ptr %uf${i} ; ${llvmCommentText(f.name)} starts undefined`,
      );
      return;
    }
    if (f.type.kind === "dyn") {
      host.declare("declare ptr @scr_dyn_undefined()");
      out.push(
        `  %ufv${i} = call ptr @scr_dyn_undefined()`,
        `  %uf${i} = getelementptr inbounds %${mangleClassStruct(meta.def.name)}, ptr %o, i64 0, i32 ${index}`,
        `  store ptr %ufv${i}, ptr %uf${i} ; ${llvmCommentText(f.name)} starts undefined`,
      );
      return;
    }
    if (f.type.kind !== "union") return;
    const tag = undefinedArmTag(f.type, host.unionsById);
    if (tag < 0) return;
    out.push(
      `  %uf${i} = getelementptr inbounds %${mangleClassStruct(meta.def.name)}, ptr %o, i64 0, i32 ${index}`,
      `  store ptr ${host.unitInstanceRef(f.type.unionId, tag)}, ptr %uf${i} ; ${llvmCommentText(f.name)} starts undefined`,
    );
  });
  return out;
}

/** Per-class LLVM emission for every non-runtime class: the struct types
 * (`typeDefs`), the vtable struct types + per-class constant instances,
 * and the new/retain/release (+releaseDirect for hierarchy members,
 * +trace/gcFree for cycle-capable shapes) definitions (`defs`). Mirrors
 * emitStructDefs + emitHierarchyClassHelpers. */
export function emitClassShapes(
  host: ClassHost,
  mod: IrModule,
  metaMap: Map<string, LlClassMeta>,
  nullable?: NullableRefFields,
  int32?: Int32Slots,
): { typeDefs: string[]; defs: string[] } {
  // Whether compact instances live in the program-lifetime region, where
  // fields and arrays can refer to them in 32 bits (LlEmitter.compactRegion).
  const regionRefs = host.compactRegion?.() === true;
  const typeDefs: string[] = [];
  const defs: string[] = [];
  const emitted = (mod.classes ?? []).filter((c) => !c.runtime);
  if (emitted.length === 0) return { typeDefs, defs };
  const audit = host.objectAudit !== false;
  if (audit) {
    host.declare(`declare void @scr_obj_alloc_note()`);
    host.declare(`declare void @scr_obj_free_note()`);
  }

  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    if (meta.compact) {
      typeDefs.push(
        `%${mangleClassStruct(cls.name)} = type { ${meta.compactElems.map((e) => e.type).join(", ")} } ` +
          `; class ${cls.name} (32-bit header) { ${meta.compactElems
            .slice(1)
            .map((e) => llvmCommentText(cls.fields[e.field]!.name))
            .join("; ")} }`,
      );
      continue;
    }
    const fieldTys = classFieldTypes(host, cls, int32);
    // Subclasses of a runtime base embed its remaining prefix (the state
    // and display-name slots) between the vtable word and the field list;
    // stream subclasses add the stream-state pointer — upcasts to
    // ScrEmitter* / ScrStream* / ScrEventTargetObj* / ScrEventObj* are the
    // usual pointer reinterprets.
    const runtimePrefix = runtimePrefixOf(meta);
    const prefix =
      cls.arrayElem !== undefined
        ? ARRAY_PREFIX
        : meta.hierarchy && !meta.idInRc
          ? streamRooted(meta)
            ? ["ptr", "ptr", "ptr", "ptr"]
            : runtimePrefix
              ? ["ptr", "ptr", "ptr"]
              : ["ptr"]
          : [];
    const members = [...prefix, ...(meta.threadSlot ? ["i32"] : []), ...fieldTys];
    typeDefs.push(
      `%${mangleClassStruct(cls.name)} = type { ${host.sizeType}${members.length ? ", " + members.join(", ") : ""} } ` +
        `; class ${cls.name}${meta.idInRc ? " (class id in rc)" : meta.hierarchy ? " (vt at 1)" : ""}${streamRooted(meta) ? " (ScrStream prefix at 2)" : runtimePrefix ? ` (${runtimePrefix.struct} prefix at 2)` : ""} { ${cls.fields.map((f) => llvmCommentText(f.name)).join("; ")} }`,
    );
  }

  // Vtable struct types, one per ROOT of the emitted hierarchy classes (a
  // runtime root — %Error — counts exactly when an emitted subclass needs
  // its type): a ScrVt head plus one ptr per slot. All slots are `ptr`, so
  // the type is layout-only.
  const roots = new Set<string>();
  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    if (meta.hierarchy) roots.add(meta.root.def.name);
  }
  for (const name of roots) {
    const root = metaMap.get(name)!;
    const slotPtrs = root.slots.map(() => "ptr").join(", ");
    typeDefs.push(
      `%${mangleVtStruct(root.def.name)} = type { %ScrVt${root.slots.length ? ", " + slotPtrs : ""} } ` +
        `; vtable: hierarchy rooted at ${root.def.name}${root.slots.length ? ` [${root.slots.map((s) => llvmCommentText(s.method)).join(", ")}]` : ""}`,
    );
  }

  // One constant vtable instance per emitted hierarchy class: interval,
  // direct release, and the class's dispatch entry for every slot — the
  // method functions THEMSELVES (no adapters; see the header comment).
  const vtInit = (meta: LlClassMeta): string => {
    const entries = vtEntriesFor(meta).map(({ slot, impl }) =>
      impl === null
        ? `ptr null` // outside the declaring subtree / fully-abstract chain
        : `ptr @${host.virtualEntry?.(`%${impl.def.name}.${slot.method}`) ?? mangleFunction(`%${impl.def.name}.${slot.method}`)}`,
    );
    const head = `%ScrVt { ${host.sizeType} ${meta.pre}, ${host.sizeType} ${meta.post}, ptr @${mangleClassReleaseDirect(meta.def.name)} }`;
    return `{ ${[head, ...entries].join(", ")} }`;
  };
  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    if (!meta.hierarchy || meta.idInRc) continue;
    defs.push(
      `@${mangleVtInstance(cls.name)} = internal constant %${mangleVtStruct(meta.root.def.name)} ` +
        `${vtInit(meta)} ; class ${cls.name}`,
      ``,
    );
  }
  // A hierarchy whose instances keep their class id in the rc word has
  // one array of its classes' vtables, in preorder: the vtable of an
  // instance is the element at its number minus the root's.
  for (const name of roots) {
    const root = metaMap.get(name)!;
    if (!root.idInRc) continue;
    const members = [...metaMap.values()]
      .filter((m) => m.root === root)
      .sort((a, b) => a.pre - b.pre);
    const vtt = `%${mangleVtStruct(root.def.name)}`;
    defs.push(
      `@${mangleVtArray(root.def.name)} = internal constant [${members.length} x ${vtt}] [`,
      ...members.map(
        (m, i) => `  ${vtt} ${vtInit(m)}${i + 1 < members.length ? "," : ""} ; class ${m.def.name}`,
      ),
      `]`,
      ``,
    );
  }

  // Classes with an out-of-line teardown (a bounded release) whose instances
  // are all of that exact class can be torn down directly by a parent's
  // teardown: standalone classes, and hierarchy leaves of program-rooted
  // hierarchies (class identity is nominal, so a reference of a leaf type
  // holds an instance of the leaf). Other hierarchy members release through
  // their dynamic class. Only classes that some class holds are.
  const storedFieldType = (cls: IrClassDef, f: IrClassDef["fields"][number]): IrType =>
    nullable?.storageType(cls.name, f.name, f.type) ?? f.type;
  // Inline scalar-union fields own nothing: no teardown, trace or release.
  const ownedFields = (cls: IrClassDef): { field: IrClassDef["fields"][number]; i: number }[] =>
    cls.fields.flatMap((field, i) =>
      host.inlineUnions.classField(cls.name, field.name) ? [] : [{ field, i }],
    );
  const candidates: [string, DirectDestroy][] = [];
  const fieldTypes: IrType[] = [];
  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    const types = ownedFields(cls).map(({ field }) => storedFieldType(cls, field));
    for (const t of types) fieldTypes.push(t);
    if (programLifetimeClass(host, meta)) continue;
    if (cls.arrayElem !== undefined) continue;
    if (meta.hierarchy && (meta.children.length !== 0 || meta.root.def.runtime === true)) continue;
    if (!types.some((t) => isRefCounted(t) && needsBoundedRelease(t))) continue;
    const release = mangleClassRelease(cls.name);
    const teardown = meta.hierarchy ? mangleClassReleaseDirect(cls.name) : release;
    candidates.push([
      `object:${cls.name}`,
      {
        release: `@${release}`,
        destroy: `${teardown}_destroy`,
        traced: host.tracedShapes.has(`object:${cls.name}`),
        ...(meta.idInRc ? { count: "i32" as const } : {}),
      },
    ]);
  }
  const directTargets = usedDirectTargets(host, candidates, fieldTypes);

  // The descriptor entries of a class declared `extends Array`: a helper
  // the module defines, or null (a class that is never constructed has
  // neither).
  const defined = new Set(mod.functions.map((fn) => fn.name));
  const arrayClassFn = (name: string | undefined): string =>
    name !== undefined && defined.has(name) ? `@${mangleFunction(name)}` : "null";
  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    const struct = mangleClassStruct(cls.name);
    const lifetime = programLifetimeClass(host, meta);
    const traced = host.tracedShapes.has(`object:${cls.name}`);
    const runtimePrefix = runtimePrefixOf(meta);
    const isStreamRooted = streamRooted(meta);
    const fieldIndex = (i: number): number => classFieldSlot(meta, i);
    // Teardown, trace and gcFree see each slot's storage type: a nullable
    // class field holds the instance pointer (NULL for the unit arm), and
    // every class retain/release/visit entry point is NULL-tolerant. A
    // compressed field refers to a compact instance, which nothing releases
    // or traces, so they skip it.
    const indexedFields = [
      ...ownedFields(cls)
        .filter(({ i }) => meta.compressed[i] !== true)
        .map(({ field, i }) => ({
          name: field.name,
          type: storedFieldType(cls, field),
          index: fieldIndex(i),
        })),
    ];
    const refFields = indexedFields.filter((f) => isRefCounted(f.type));
    const tracedFields = traced
      ? indexedFields.filter((f) => traceAdapter(host, f.type) !== null)
      : [];
    // A traced class whose trace visits nothing carries the collector header
    // only because its hierarchy is traced: it is never on a cycle. Its
    // descriptor names scr_cyc_no_children and its objects start out
    // SCR_CYC_ACYCLIC, so releases never buffer them.
    const acyclic =
      traced && runtimePrefix === null && !isStreamRooted && tracedFields.length === 0;
    const bounded =
      runtimePrefix !== null ||
      isStreamRooted ||
      refFields.some((field) => needsBoundedRelease(field.type));
    const sizeOf = `ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 1) to ${host.sizeType})`;
    // An embedded prefix slot (the runtime base's state at 2, the stream
    // state at 4) handed to one of the runtime's prefix helpers —
    // teardown/trace/collector.
    const prefixCall = (
      tag: string,
      slot: number,
      entry: string,
      tail: string,
      what: string,
    ): string[] => {
      host.declare(`declare void @${entry}(ptr${tail ? ", ptr, ptr" : ""})`);
      return [
        `  %${tag}p = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${slot}`,
        `  %${tag}v = load ptr, ptr %${tag}p`,
        `  call void @${entry}(ptr %${tag}v${tail}) ; ${what}`,
      ];
    };
    const regCall = (tag: string, entry: string, tail: string): string[] =>
      prefixCall(tag, 2, entry, tail, runtimePrefix?.what ?? "");
    const stCall = (tag: string, entry: string, tail: string): string[] =>
      prefixCall(tag, 4, entry, tail, "stream state (ScrStream prefix)");

    // retain: NULL-tolerant, immortal-skip — layout-generic (rc at 0), so
    // hierarchy members need no dispatch.
    // An instance that keeps its class id in the rc word counts in the
    // low half (CLASS_ID_OFFSET).
    const count = meta.idInRc ? "i32" : host.sizeType;
    defs.push(
      ...retainBody(host, mangleClassRetain(cls.name), `retain ${cls.name}`, lifetime, count),
      ``,
    );

    // An out-of-line teardown tears typed children down directly
    // (directChildReleaseLines). It takes the chain length when it has such
    // children or is itself a direct target.
    const chained =
      bounded &&
      (directTargets.has(`object:${cls.name}`) ||
        refFields.some((f) => directDestroyTarget(host, f.type, directTargets) !== null));
    // The teardown's own symbol, and whether it keeps a segment (shapes.ts
    // segmentedTeardown).
    const destroy = `${meta.hierarchy ? mangleClassReleaseDirect(cls.name) : mangleClassRelease(cls.name)}_destroy`;
    const segmented =
      chained &&
      cls.arrayElem === undefined &&
      !meta.compact &&
      runtimePrefix === null &&
      !isStreamRooted &&
      !meta.threadSlot &&
      segmentedTeardown(
        host,
        destroy,
        refFields.map((f) => f.type),
        directTargets,
      );
    // The field-releasing teardown body shared by both release shapes
    // (the public one on standalone classes, the DIRECT one on hierarchy
    // members). Runs at rc == 0.
    const teardown = (lines: string[]): void => {
      const release = (prefix: string, f: (typeof refFields)[number], t: number): string[] => {
        // An Array subclass instance's destroy releases its fields plainly
        // (it takes no chain length).
        const direct =
          bounded && cls.arrayElem === undefined
            ? directDestroyTarget(host, f.type, directTargets)
            : null;
        if (direct === null)
          return [
            `  call void ${releaseSym(host, f.type)}(ptr %v${t}) ; ${llvmCommentText(f.name)}`,
          ];
        const own = segmented && direct.destroy === destroy;
        return directChildReleaseLines(
          host,
          `${prefix}${t}`,
          `%v${t}`,
          direct,
          llvmCommentText(f.name),
          own,
        );
      };
      const loads = refFields.map((f, t) => [
        `  %f${t} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
        `  %v${t} = load ptr, ptr %f${t}`,
      ]);
      if (segmented) {
        // A segmented teardown loads its fields, releases its own block, and
        // then releases the fields (shapes.ts segmentTeardownLines).
        const ownType = refFields.flatMap((f, t) =>
          directDestroyTarget(host, f.type, directTargets)?.destroy === destroy ? [`%v${t}`] : [],
        );
        lines.push(
          ...segmentPrologueLines(),
          ...loads.flat(),
          ...emitObjectFree(host, traced, "weak", "%sg.own"),
          ...segmentTeardownLines(ownType, (prefix) =>
            refFields.flatMap((f, t) => release(prefix, f, t)),
          ),
        );
        return;
      }
      refFields.forEach((f, t) => lines.push(...loads[t]!, ...release("td", f, t)));
      if (runtimePrefix) lines.push(...regCall("td", runtimePrefix.drop, ""));
      if (isStreamRooted) lines.push(...stCall("tds", "scr_stream_st_release", ""));
      if (meta.threadSlot) lines.push(...slotForgetLines(host, struct, meta, "tdw"));
      lines.push(...emitObjectFree(host, traced));
    };

    if (meta.hierarchy) {
      // Public release: NULL/immortal checks, then dispatch through the
      // object's vtable so a base-typed release tears down the DERIVED
      // object (scr_error_release's contract exactly). In a hierarchy the
      // program owns end to end (no runtime root), every member shares the
      // rc word and the header decision (cycle-analysis groups hierarchies),
      // so a release that leaves the object alive is the same for every
      // class: the inlinable fast path decrements without the indirect call,
      // and only the last reference reaches the dispatching release.
      const userRooted = meta.root.def.runtime !== true;
      const dispatchName = userRooted
        ? `${mangleClassRelease(cls.name)}_slow`
        : mangleClassRelease(cls.name);
      if (userRooted)
        defs.push(
          ...releaseFastPath(
            host,
            mangleClassRelease(cls.name),
            dispatchName,
            traced,
            `release ${cls.name}`,
            lifetime,
            count,
          ),
          ``,
        );
      defs.push(
        `define internal void @${dispatchName}(ptr %o) ${userRooted ? "noinline " : ""}${FN_ATTRS} { ; release ${cls.name} (dispatches)`,
        `entry:`,
        `  %isnull = icmp eq ptr %o, null`,
        `  br i1 %isnull, label %done, label %check`,
        `check:`,
        `  %rc = load ${count}, ptr %o`,
        `  %imm = icmp eq ${count} %rc, -1`,
        `  br i1 %imm, label %done, label %disp`,
        `disp:`,
        ...(meta.idInRc
          ? classIdVtLines(meta, "%o", "%vt", "")
          : [
              `  %vtp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 1`,
              `  %vt = load ptr, ptr %vtp`,
            ]),
        `  %relp = getelementptr inbounds %ScrVt, ptr %vt, i64 0, i32 2`,
        `  %rel = load ptr, ptr %relp`,
        `  call void %rel(ptr %o) ; the DYNAMIC class's teardown`,
        `  br label %done`,
        `done:`,
        `  ret void`,
        `}`,
        ``,
      );
      // Direct release (the vtable entry): the class's own teardown. The
      // caller already handled NULL/immortal. A compact instance has no
      // count: nothing releases it.
      if (meta.compact) {
        defs.push(
          `define internal void @${mangleClassReleaseDirect(cls.name)}(ptr %o) ${FN_ATTRS} { ; direct release ${cls.name} (immortal)`,
          `entry:`,
          `  ret void`,
          `}`,
          ``,
        );
      } else {
        const reld: string[] = [
          `define internal void @${mangleClassReleaseDirect(cls.name)}(ptr %o) ${FN_ATTRS} { ; direct release ${cls.name}`,
          `entry:`,
          `  %rc = load ${count}, ptr %o`,
          `  %n = sub ${count} %rc, 1`,
          `  store ${count} %n, ptr %o`,
          `  %dead = icmp eq ${count} %n, 0`,
          `  br i1 %dead, label %free, label %${traced ? "root" : "done"}`,
          `free:`,
        ];
        if (traced) reld.push(...cycleDeadLines(host, "teardown"));
        if (bounded) {
          const destroyBody: string[] = [];
          teardown(destroyBody);
          defs.push(
            ...destroyDefinitions(destroy, destroyBody, chained, segmented ? host : null),
            ``,
          );
          host.declare(`declare void @scr_rc_destroy(ptr, ptr)`);
          reld.push(`  call void @scr_rc_destroy(ptr %o, ptr @${destroy})`);
        } else teardown(reld);
        reld.push(`  br label %done`);
        if (traced) reld.push(`root:`, ...cycleRootLines(host, "done"));
        reld.push(`done:`, `  ret void`, `}`, ``);
        defs.push(...reld);
      }
    } else if (cls.arrayElem !== undefined) {
      // An instance is an array: its release is the array's, which reaches
      // the class's destroy (the descriptor's) when the count reaches zero.
      host.declare(`declare void @scr_arr_release(ptr)`);
      host.declare(`declare void @scr_arr_subclass_drop(ptr)`);
      const destroy = `${mangleClassRelease(cls.name)}.arrdestroy`;
      const destroyBody: string[] = [
        `define internal void @${destroy}(ptr %o) ${FN_ATTRS} { ; destroy ${cls.name} (an Array subclass instance)`,
        `entry:`,
      ];
      const fieldsTeardown: string[] = [];
      teardown(fieldsTeardown);
      const free = emitObjectFree(host, traced);
      destroyBody.push(
        ...fieldsTeardown.slice(0, fieldsTeardown.length - free.length),
        `  call void @scr_arr_subclass_drop(ptr %o)`,
        ...free,
        `  ret void`,
        `}`,
        ``,
      );
      const displayName = cls.name.includes(".")
        ? cls.name.slice(cls.name.lastIndexOf(".") + 1)
        : cls.name;
      const jsName = cls.jsName ?? displayName;
      defs.push(
        ...destroyBody,
        // The name is the class's own copy: its address identifies the
        // class in dyn snapshots of an instance (scr_arr_copy_metadata).
        `${arrayClassDescriptor(cls.name)}.name = private constant [${Buffer.byteLength(jsName, "utf8") + 1} x i8] c"${nulTerminatedBytes(jsName)}"`,
        `${arrayClassDescriptor(cls.name)} = internal constant { ptr, ptr, ptr, ptr } { ptr ${arrayClassDescriptor(cls.name)}.name, ptr @${destroy}, ptr ${arrayClassFn(cls.arrayFields)}, ptr ${arrayClassFn(cls.arraySpecies)} }`,
        ``,
        `define internal void @${mangleClassRelease(cls.name)}(ptr %o) ${FN_ATTRS} { ; release ${cls.name} (the array's)`,
        `entry:`,
        `  call void @scr_arr_release(ptr %o)`,
        `  ret void`,
        `}`,
        ``,
      );
    } else {
      const freeBody: string[] = [];
      teardown(freeBody);
      defs.push(
        ...releaseBody(
          host,
          mangleClassRelease(cls.name),
          traced,
          freeBody,
          `release ${cls.name}`,
          bounded,
          lifetime,
          chained,
          segmented,
        ),
        ``,
      );
    }

    // new: zeroed allocation, rc = 1, the vtable word on hierarchy
    // members, undefined-admitting union fields at the interned unit
    // instance. Traced shapes allocate with the collector header; alloc.ts
    // inlines the allocator fast paths and the alloc note.
    const nw: string[] = [
      `define internal ptr @${mangleClassNew(cls.name)}() ${FN_ATTRS} { ; new ${cls.name}`,
      `entry:`,
    ];
    const cycType = `@${mangleClassTrace(cls.name)}.cyctype`;
    if (acyclic) host.declare(`declare void @scr_cyc_no_children(ptr, ptr, ptr)`);
    if (traced)
      defs.push(
        cycTypeDescriptor(
          cycType,
          acyclic ? "@scr_cyc_no_children" : `@${mangleClassTrace(cls.name)}`,
          `@${mangleClassGcFree(cls.name)}`,
          host.nextCycKind?.() ?? 0,
        ),
        ``,
      );
    // A program-lifetime instance is never freed: no collector header
    // (nothing walks or frees it) and the program-lifetime count, which
    // publication turns into SIZE_MAX (programLifetimeRc). Programs with
    // lifetime regions allocate it in the current region, which frees it
    // with the region (llvm/regions.ts).
    const regions: RegionHooks | null = lifetime ? (host.regions ?? null) : null;
    if (regions !== null) {
      nw.push(...regions.newAlloc(cls.name, sizeOf));
      defs.push(...regions.classDefinitions(cls, sizeOf));
    } else if (meta.compact && regionRefs) {
      // Compressed fields refer to compact instances by their index in the
      // program-lifetime region, so every compact instance lives there:
      // zeroed, 8-byte aligned and never freed.
      nw.push(...plrAllocLines(host, sizeOf));
    } else
      nw.push(
        ...emitObjectAlloc(
          host,
          sizeOf,
          traced && !lifetime ? { type: cycType, acyclic } : null,
          storedHeaderBytes(meta),
        ),
      );
    if (meta.compact && !meta.hierarchy)
      nw.push(`  store i32 ${compactHeaderWord(meta)}, ptr %o ; no count (compactHeaderWord)`);
    else if (meta.compact) {
      // The header word: the class id and no count (compactHeaderWord).
      // Only publication writes it again, setting COMPACT_PUBLISHED in the
      // top byte, so the class id reads that carry !invariant.group read
      // the low 16 bits only (classIdLoadLines).
      host.declare(`declare ptr @llvm.launder.invariant.group.p0(ptr)`);
      nw.push(
        `  %o.vt = call ptr @llvm.launder.invariant.group.p0(ptr %o)`,
        `  store i32 ${compactHeaderWord(meta)}, ptr %o.vt ; class ${llvmCommentText(cls.name)} is ${meta.pre}`,
      );
    } else if (meta.idInRc) {
      // The class id in the high half of the rc word, the count in the low
      // half (classIdRcWord). It never changes while the object lives:
      // retains, releases and the runtime write only the low half.
      host.declare(`declare ptr @llvm.launder.invariant.group.p0(ptr)`);
      nw.push(
        `  %o.vt = call ptr @llvm.launder.invariant.group.p0(ptr %o)`,
        `  store i64 ${classIdRcWord(meta, lifetime)}, ptr %o.vt ; class ${llvmCommentText(cls.name)} is ${meta.pre}`,
      );
    } else
      nw.push(
        `  store ${host.sizeType} ${lifetime ? programLifetimeRc(host.sizeType) : 1}, ptr %o`,
      );
    if (cls.arrayElem !== undefined) {
      const init = arrElemInit(host, cls.arrayElem);
      host.declare(`declare void @scr_arr_subclass_init(ptr, i8, ptr, ptr, i1 zeroext)`);
      nw.push(
        `  call void @scr_arr_subclass_init(ptr %o, i8 ${init.kind}, ptr ${init.ops}, ptr ${arrayClassDescriptor(cls.name)}, i1 ${traced})`,
      );
    }
    if (lifetime && audit) {
      // --sanitize builds: the RC audit skips its leak report when the
      // program keeps program-lifetime objects (scr_console.c), and
      // LeakSanitizer scans them as roots (scr_object.c).
      host.declare(`declare void @scr_obj_lifetime_note(ptr)`);
      nw.push(`  call void @scr_obj_lifetime_note(ptr %o)`);
    }
    if (meta.hierarchy && !meta.idInRc) {
      // The vtable word is written once, here, and never changes while the
      // object lives: its store and the virtual-call loads carry
      // !invariant.group. A recycled block may have held an object of
      // another class, so the result is laundered first: every lifetime
      // gets a fresh pointer identity for the group.
      host.declare(`declare ptr @llvm.launder.invariant.group.p0(ptr)`);
      nw.push(
        `  %o.vt = call ptr @llvm.launder.invariant.group.p0(ptr %o)`,
        `  %vtp = getelementptr inbounds %${struct}, ptr %o.vt, i64 0, i32 1`,
        `  store ptr @${mangleVtInstance(cls.name)}, ptr %vtp, !invariant.group !{}`,
      );
    }
    if (runtimePrefix) {
      // The runtime prefix: the state stays NULL (zeroed allocation); the
      // display name Node's leak warnings and inspectors print is the
      // source class name, without the module qualifier (shapes.ts's rule).
      const displayName = cls.name.includes(".")
        ? cls.name.slice(cls.name.lastIndexOf(".") + 1)
        : cls.name;
      nw.push(
        `  %clsp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 3`,
        `  store ptr ${host.cstr(displayName)}, ptr %clsp ; ${runtimePrefix.what} display name`,
      );
    }
    nw.push(...undefFieldInits(host, meta, nullable));
    // Young instances: program-owned traced classes. Classes rooted at a
    // runtime base (errors, emitters, events, streams) carry runtime state
    // and stay with trial deletion, like every runtime family.
    if (
      traced &&
      !lifetime &&
      (!meta.hierarchy || meta.root.def.runtime !== true) &&
      cls.arrayElem === undefined
    )
      nw.push(...youngEntryLines(host));
    nw.push(`  ret ptr ${meta.hierarchy ? "%o.vt" : "%o"}`, `}`, ``);
    defs.push(...nw);

    if (traced) {
      // trace: visit exactly the cycle-capable fields; gcFree: release
      // exactly the complement, then free (the trace/teardown complement
      // contract in scr_runtime.h).
      const indexed = indexedFields;
      const untracedRefFields = indexed.filter(
        (f) => isRefCounted(f.type) && traceAdapter(host, f.type) === null,
      );
      const tr: string[] = [
        `define internal void @${mangleClassTrace(cls.name)}(ptr %o, ptr %visit, ptr %ctx) ${FN_ATTRS} { ; trace ${cls.name}`,
        `entry:`,
      ];
      if (runtimePrefix) tr.push(...regCall("tr", runtimePrefix.trace, ", ptr %visit, ptr %ctx"));
      if (isStreamRooted)
        tr.push(...stCall("trs", "scr_stream_st_trace", ", ptr %visit, ptr %ctx"));
      tracedFields.forEach((f, i) => {
        tr.push(...traceFieldVisitLines(struct, f.index, i, llvmCommentText(f.name)));
      });
      // An Array subclass instance's elements, when its current element
      // storage is cycle-capable (a species result can retype it).
      if (cls.arrayElem !== undefined) {
        host.declare(`declare void @scr_arr_subclass_trace(ptr, ptr, ptr)`);
        tr.push(`  call void @scr_arr_subclass_trace(ptr %o, ptr %visit, ptr %ctx) ; the elements`);
      }
      tr.push(`  ret void`, `}`, ``);
      defs.push(...tr);

      const gf: string[] = [
        `define internal void @${mangleClassGcFree(cls.name)}(ptr %o) ${FN_ATTRS} { ; gcFree ${cls.name}`,
        `entry:`,
      ];
      if (runtimePrefix) gf.push(...regCall("gf", runtimePrefix.gcFree, ""));
      if (isStreamRooted) gf.push(...stCall("gfs", "scr_stream_st_gcfree", ""));
      untracedRefFields.forEach((f, i) => {
        gf.push(
          `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
          `  %v${i} = load ptr, ptr %f${i}`,
          `  call void ${releaseSym(host, f.type)}(ptr %v${i}) ; ${llvmCommentText(f.name)} (acyclic)`,
        );
      });
      if (meta.threadSlot) gf.push(...slotForgetLines(host, struct, meta, "gfw"));
      if (cls.arrayElem !== undefined) {
        // The elements: traced ones are the collector's, the others are
        // released with the storage (the same test as the trace's).
        host.declare(`declare void @scr_arr_subclass_gc_drop(ptr)`);
        gf.push(`  call void @scr_arr_subclass_gc_drop(ptr %o)`);
      }
      gf.push(...emitObjectFree(host, true), `  ret void`, `}`, ``);
      defs.push(...gf);
    }
  }
  return { typeDefs, defs };
}

/** Class objects (classes as first-class values): the immortal ScrClassObj
 * statics plus their construct thunks — allocate, run the constructor over
 * a +1 `this`, and hand the remaining +1 out. No pending check is needed:
 * in-tier constructors are throw-free by construction.
 * `classObjs` maps className → { nameSym, baseNameSym } registered during
 * body emission (the literals interned while the table was open). */
export function emitClassObjDefs(
  host: ClassHost,
  metaMap: Map<string, LlClassMeta>,
  classObjs: Map<string, { nameSym: string; baseNameSym: string | null }>,
  fnByName: Map<string, IrFunction>,
  llType: (t: IrType) => string,
  threadLocal = false,
): string[] {
  const out: string[] = [];
  for (const [className, { nameSym, baseNameSym }] of classObjs) {
    const meta = metaMap.get(className);
    if (!meta)
      throw new InternalCompilerError(
        `llvm emitter bug: class object for unknown class ${className}`,
      );
    // A generic instantiation's class object carries its FAMILY's interval
    // (JS has ONE `Box` at runtime); construction still dispatches the
    // instantiation's own thunk.
    const intervalMeta = meta.def.genericOf !== undefined ? metaMap.get(meta.def.genericOf) : meta;
    if (!intervalMeta) {
      throw new InternalCompilerError(
        `llvm emitter bug: class object for ${className} names unknown family ${meta.def.genericOf ?? ""}`,
      );
    }
    const valueCtor = classValueConstructor(meta.def);
    const ctor = fnByName.get(valueCtor.fn);
    if (!ctor)
      throw new InternalCompilerError(
        `llvm emitter bug: class object for ${className} without a constructor`,
      );
    const params = ctor.params.slice(valueCtor.firstArg);
    const paramDecls = params.map((p, i) => `${llType(p.type)} %a${i}`).join(", ");
    const ctorArgs = params.map((p, i) => `${llType(p.type)} %a${i}`);
    const classObj =
      `@${mangleClassObj(className)} = internal ${threadLocal ? "thread_local " : ""}global %ScrClassObj ` +
      `{ ${host.sizeType} -1, ${host.sizeType} ${intervalMeta.pre}, ${host.sizeType} ${intervalMeta.post}, ptr @${mangleCtorThunk(className)}, ptr ${nameSym}, ${host.sizeType} 0, ${host.sizeType} ${meta.def.jsLength ?? (meta.def.runtime ? 1 : 0)}, ptr null, ptr null, ptr ${baseNameSym ?? "null"}, ${host.sizeType} ${meta.def.ownStaticFields ? 1 : 0} } ; class ${className}`;
    if (meta.def.runtime) {
      // A runtime-provided class: %C.construct allocates through the
      // runtime and returns the instance.
      out.push(
        `define internal ptr @${mangleCtorThunk(className)}(ptr %class${paramDecls ? ", " + paramDecls : ""}) ${FN_ATTRS} { ; construct thunk ${className}`,
        `entry:`,
        `  %o = call ptr @${mangleFunction(valueCtor.fn)}(${ctorArgs.join(", ")})`,
        `  ret ptr %o`,
        `}`,
        classObj,
        ``,
      );
      continue;
    }
    if (meta.def.localCaptures !== undefined)
      host.declare(`declare ptr @scr_classobj_retain_v(ptr)`);
    const localBaseInits: string[] = [];
    let localOwner = meta;
    let localValue = "%class";
    let localIndex = 0;
    while (localOwner.base) {
      if (
        localOwner.def.localBaseCapture === undefined &&
        localOwner.def.baseValueGlobal === undefined
      ) {
        localOwner = localOwner.base;
        continue;
      }
      host.declare(`declare ptr @scr_box_get_ref(ptr)`);
      const id = localIndex++;
      const base = localOwner.base;
      if (localOwner.def.baseValueGlobal !== undefined) {
        host.declare(`declare ptr @scr_classobj_retain_v(ptr)`);
        localBaseInits.push(
          `  %base.raw${id} = load ptr, ptr @${mangleGlobal(localOwner.def.baseValueGlobal)}`,
          `  %base.value${id} = call ptr @scr_classobj_retain_v(ptr %base.raw${id})`,
        );
      } else
        localBaseInits.push(
          `  %base.caps${id} = getelementptr inbounds %ScrClassObj, ptr ${localValue}, i64 1`,
          `  %base.cap${id} = getelementptr inbounds ptr, ptr %base.caps${id}, ${host.sizeType} ${localOwner.def.localBaseCapture}`,
          `  %base.box${id} = load ptr, ptr %base.cap${id}`,
          `  %base.value${id} = call ptr @scr_box_get_ref(ptr %base.box${id})`,
        );
      if (base.def.localCaptures !== undefined)
        localBaseInits.push(
          `  %base.slot${id} = getelementptr inbounds %${mangleClassStruct(base.def.name)}, ptr %o, i64 0, i32 ${classEnvironmentIndex(base)}`,
          `  store ptr %base.value${id}, ptr %base.slot${id}`,
        );
      else {
        host.declare(`declare void @scr_classobj_release_v(ptr)`);
        localBaseInits.push(`  call void @scr_classobj_release_v(ptr %base.value${id})`);
      }
      localOwner = base;
      localValue = `%base.value${id}`;
    }
    out.push(
      `define internal ptr @${mangleCtorThunk(className)}(ptr %class${paramDecls ? ", " + paramDecls : ""}) ${FN_ATTRS} { ; construct thunk ${className}`,
      `entry:`,
      `  %o = call ptr @${mangleClassNew(className)}()`,
      ...(meta.def.localCaptures !== undefined
        ? [
            `  %class.owned = call ptr @scr_classobj_retain_v(ptr %class)`,
            `  %class.slot = getelementptr inbounds %${mangleClassStruct(className)}, ptr %o, i64 0, i32 ${classEnvironmentIndex(meta)}`,
            `  store ptr %class.owned, ptr %class.slot`,
          ]
        : []),
      ...localBaseInits,
      `  %r = call ptr @${mangleClassRetain(className)}(ptr %o)`,
      `  call void @${mangleFunction(`%${className}.constructor`)}(${[`ptr %r`, ...ctorArgs].join(", ")})`,
      `  ret ptr %o`,
      `}`,
      classObj,
      ``,
    );
  }
  return out;
}
