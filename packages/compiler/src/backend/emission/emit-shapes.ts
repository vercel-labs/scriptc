/* Per-shape C emission: class/record struct definitions and their RC/trace
 * helper families, the hierarchy vtable machinery (slot structs, per-class
 * instances, exact-signature adapter thunks), and the capture-box
 * constructors. Everything here is driven by the class graph (ClassMeta,
 * VtSlot) the emitter builds up front; emission ORDER is part of the C. */
import type { CEmitter } from "./emitter.js";
import type { IrFunction } from "../../ir/nodes.js";
import { IrClassDef, IrType, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, isRefCounted, mapOf, STRING } from "../../ir/nodes.js";
import { mangleClassGcFree, mangleClassNew, mangleClassRelease, mangleClassReleaseDirect, mangleClassRetain, mangleClassStruct, mangleClassTrace, mangleCtorThunk, mangleField, mangleFunction, mangleRecordClone, mangleRecordGcFree, mangleRecordNew, mangleRecordRelease, mangleRecordRetain, mangleRecordStruct, mangleRecordTrace, mangleVtAdapter, mangleVtInstance, mangleVtStruct } from "../mangle.js";
import { boxKindC, cDecl, cType, elemKindC, mapValKindC, releaseCallC, retainCallC, vAdapters } from "./emit-types.js";

/** The overflow map's C member name on index-signature record structs.
 * User fields mangle to `sc_fld_*`, so no field can collide. */
export const OVERFLOW_MEMBER = "sc_ovf";

/** True when the class descends from a runtime stream class: its struct
 * embeds the FULL ScrStream prefix (registry, display name, state
 * pointer) and its RC/trace helpers delegate the state block to
 * scr_stream_st_*. */
function streamRooted(meta: ClassMeta): boolean {
  for (let m = meta.base; m; m = m.base) {
    if (RUNTIME_STREAM_CLASSES.has(m.def.name)) return true;
  }
  return false;
}

/** One virtual method slot of a hierarchy: the ROOT-MOST declaring class
 * owns the slot; its declaration's IrFunction fixes the slot's C signature
 * (`this` typed as the declarer — implementations sit behind reinterpreting
 * adapters). Only methods overridden somewhere get slots. */
export interface VtSlot {
  method: string;
  declarer: ClassMeta;
  fn: IrFunction;
  /** The slot's C member name, unique WITHIN its root's vtable struct:
   * sibling branches can each own a slot for the same method name
   * (mangleVtSlot's occurrence ordinal disambiguates). */
  member: string;
}

/** Per-class node of the class graph (see CEmitter.classMeta). `pre`/`post`
 * are the preorder interval over the whole-program class forest — a class's
 * descendants are exactly the classes whose `pre` lies inside it, which is
 * both the instanceof check and the slot-lookup subtree test. */
export interface ClassMeta {
  def: IrClassDef;
  base: ClassMeta | null;
  children: ClassMeta[];
  root: ClassMeta;
  pre: number;
  post: number;
  hierarchy: boolean;
  /** Root classes: the hierarchy's slots in DFS-declaration order. */
  slots: VtSlot[];
}

/** Per-shape C structs + RC helpers for classes AND record shapes (the
   * layouts are identical: `size_t rc` header + fields). All structs are
   * forward-declared first so fields can reference any shape regardless of
   * order (classes nesting records, records nesting classes, mutual
   * references), and the RC helpers are prototyped before any body so a
   * release can call another shape's release regardless of emission order.
   * The `_v` adapters give boxes untyped RC entry points without UB casts.
   *
   * Cycle-capable shapes (the constructor fixpoint) additionally get a
   * cycle header (scr_cyc_alloc) plus two collector entry points: a trace
   * visiting exactly the cycle-capable fields, and a teardown releasing
   * exactly the other refcounted fields (the trace/teardown complement
   * contract in scr_runtime.h) — and their retain/release feed the
   * candidate-root buffer. Acyclic shapes keep the lean 1-word header. */
  export function emitStructDefs(E: CEmitter, out: string[]): void {
    interface StructShape {
      struct: string;
      newFn: string;
      retain: string;
      release: string;
      trace: string;
      gcFree: string;
      traced: boolean;
      fields: { name: string; type: IrType }[];
      /** Records with a string index signature: the overflow map's VALUE
       * type. The struct carries a trailing `ScrMap *` member the shape's
       * new/release/trace treat as one more (map-typed) field. */
      indexValue?: IrType;
      comment: string;
      /** Record shape id; absent for classes. */
      recordId?: string;
      /** Class shapes only; hierarchy members get the vtable machinery. */
      meta: ClassMeta | null;
    }
    // Runtime-provided classes (the builtin Error hierarchy) emit NOTHING
    // here — struct, RC helpers, and vtables live in the runtime. They keep
    // their ClassMeta (preorder numbering, instanceof constants, vtable
    // struct type for user subclasses); main() stamps their intervals.
    const shapes: StructShape[] = [
      ...(E.mod.classes ?? []).filter((cls) => !cls.runtime).map((cls) => ({
        struct: mangleClassStruct(cls.name),
        newFn: mangleClassNew(cls.name),
        retain: mangleClassRetain(cls.name),
        release: mangleClassRelease(cls.name),
        trace: mangleClassTrace(cls.name),
        gcFree: mangleClassGcFree(cls.name),
        traced: E.tracedShapes.has(`object:${cls.name}`),
        fields: cls.fields,
        comment: `class ${cls.name}`,
        meta: E.classMeta.get(cls.name) ?? null,
      })),
      ...(E.mod.records ?? []).map((rec) => ({
        struct: mangleRecordStruct(rec.id),
        newFn: mangleRecordNew(rec.id),
        retain: mangleRecordRetain(rec.id),
        release: mangleRecordRelease(rec.id),
        trace: mangleRecordTrace(rec.id),
        gcFree: mangleRecordGcFree(rec.id),
        traced: E.tracedShapes.has(`record:${rec.id}`),
        fields: rec.fields,
        recordId: rec.id,
        ...(rec.indexValue ? { indexValue: rec.indexValue } : {}),
        comment: `record ${rec.id} { ${rec.fields.map((f) => f.name).join("; ")}${rec.indexValue ? "; [key: string]" : ""} }`,
        meta: null,
      })),
    ];
    if (shapes.length === 0) return;
    const inHierarchy = (s: StructShape): boolean => s.meta !== null && s.meta.hierarchy;
    // The RC-relevant members of a shape: every field, plus the overflow
    // map on index-signature shapes — release/trace/teardown treat it as
    // one more map-typed member (traceAdapterC's map rule answers whether
    // the record's trace must visit it).
    const rcMembers = (s: StructShape): { member: string; type: IrType; name: string }[] => [
      ...s.fields.map((f) => ({ member: mangleField(f.name), type: f.type, name: f.name })),
      ...(s.indexValue
        ? [{ member: OVERFLOW_MEMBER, type: mapOf(STRING, s.indexValue), name: "[key: string] overflow" }]
        : []),
    ];
    // CLASS newFns start every undefined-armed union field at JS's
    // `undefined` — the interned immortal unit instance — instead of the
    // calloc NULL: tsc's strictPropertyInitialization accepts such fields
    // with no initializer and no constructor assignment (undefined is in
    // the type), so a fresh instance is readable before any assignment
    // runs — a method assigns later, a constructor branch skips it, a base
    // constructor's virtual call reads a derived field before super()
    // returns. Node reads `undefined` there; a NULL ScrUnion would be a
    // segfault. Class shapes only: record shapes are fully written at
    // every construction site (literal lowering fills omitted optional
    // fields, the dynCheck/JSON builders fill missing keys), and the
    // immortal instance costs nothing if overwritten (releases skip it).
    const undefFieldInitC = (s: StructShape): string[] =>
      s.meta === null ? [] : s.fields.flatMap((f) => E.undefFieldInitLineC(f.name, f.type));
    // The overflow map's construction call (in the shape's newFn): value
    // handling is type-directed exactly like a user Map's.
    const overflowNewC = (s: StructShape): string => {
      const v = s.indexValue!;
      const valKind = mapValKindC(v);
      if (valKind !== "SCR_MAP_VAL_REF") {
        return `scr_map_new(SCR_MAP_KEY_STR, ${valKind}, NULL, NULL, NULL)`;
      }
      const rc = vAdapters(v);
      return `scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_REF, &${rc.retain}, &${rc.release}, ${E.traceArgC(v)})`;
    };

    for (const s of shapes) {
      out.push(`typedef struct ${s.struct} ${s.struct}; /* ${s.comment} */`);
    }
    out.push("");
    for (const s of shapes) {
      out.push(`struct ${s.struct} { /* ${s.comment} */`, `  size_t rc;`);
      if (inHierarchy(s)) {
        // The hierarchy prefix: base fields follow at identical offsets in
        // every subclass, so vt must sit between rc and the field list.
        out.push(`  const ScrVt *vt;`);
        if (s.meta!.root.def.name === RUNTIME_EMITTER_CLASS) {
          // Emitter subclasses embed ScrEmitter's remaining prefix (the
          // registry and display-name slots) so an upcast to ScrEmitter*
          // is the usual pointer reinterpret. Carried by the BACKEND —
          // the IR field lists stay empty for it.
          out.push(
            `  ScrEeReg *sc_eereg; /* EventEmitter registry (ScrEmitter prefix) */`,
            `  const char *sc_eecls; /* EventEmitter display name (ScrEmitter prefix) */`,
          );
          if (streamRooted(s.meta!)) {
            // Stream subclasses embed ScrStream's remaining slot: the
            // state pointer, NULL until the constructor's super(options)
            // reaches scr_stream_init_* — so an upcast to ScrStream* (and
            // on through ScrEmitter*) is the usual pointer reinterpret.
            out.push(`  ScrStreamState *sc_st; /* stream state (ScrStream prefix) */`);
          }
        }
      }
      for (const f of s.fields) {
        out.push(`  ${cDecl(f.type, mangleField(f.name))}; /* ${f.name} */`);
      }
      if (s.indexValue) {
        out.push(`  ScrMap *${OVERFLOW_MEMBER}; /* [key: string] overflow (string-keyed) */`);
      }
      out.push(`};`);
    }
    out.push("");
    // Vtable struct typedefs are named after hierarchy ROOTS, which may be
    // a runtime error class (a user `extends Error` subclass's vtable
    // instance is typed by the %Error root's struct) — so typedefs come
    // from the EMITTED hierarchy classes' roots, while adapter prototypes,
    // instances, and helpers stay shapes-only (the runtime owns the
    // builtin classes; a subclass-free Error tree emits nothing at all).
    E.emitVtableDecls(out, shapes.filter(inHierarchy).map((s) => s.meta!));
    for (const s of shapes) {
      out.push(
        `static ${s.struct} *${s.retain}(${s.struct} *o);`,
        `static void ${s.release}(${s.struct} *o);`,
        `static ${s.struct} *${s.newFn}(void);`,
      );
      if (s.recordId !== undefined && E.recordCloneShapes.has(s.recordId)) {
        out.push(`static ${s.struct} *${mangleRecordClone(s.recordId)}(${s.struct} *src);`);
      }
      if (inHierarchy(s)) {
        out.push(`static void ${mangleClassReleaseDirect(s.meta!.def.name)}(void *o0);`);
      }
      if (s.traced) {
        out.push(
          `static void ${s.trace}(void *o, ScrTraceVisit visit, void *ctx);`,
          `static void ${s.gcFree}(void *o);`,
        );
      }
    }
    out.push("");
    E.emitVtableInstances(out, shapes.filter(inHierarchy).map((s) => s.meta!));
    for (const s of shapes) {
      if (inHierarchy(s)) {
        E.emitHierarchyClassHelpers(out, s.meta!, s);
        continue;
      }
      // NULL-tolerant: zeroed fields (calloc) and user `null as unknown as C`
      // casts can put NULL where an object is expected.
      if (!s.traced) {
        out.push(
          `static ${s.struct} *${s.retain}(${s.struct} *o) {`,
          `  if (o && o->rc != SIZE_MAX) o->rc++;`,
          `  return o;`,
          `}`,
          `static void ${s.release}(${s.struct} *o) {`,
          `  if (!o || o->rc == SIZE_MAX) return;`,
          `  if (--o->rc == 0) {`,
        );
        for (const m of rcMembers(s)) {
          if (!isRefCounted(m.type)) continue;
          const field = `o->${m.member}`;
          out.push(`    if (${field}) ${releaseCallC(m.type, field)};`);
        }
        out.push(
          `    scr_obj_free_note();`,
          `    free(o);`,
          `  }`,
          `}`,
          `static ${s.struct} *${s.newFn}(void) {`,
          `  ${s.struct} *o = calloc(1, sizeof *o);`,
          `  if (!o) { scr_trap("scriptc: out of memory\\n"); }`,
          `  o->rc = 1;`,
          ...undefFieldInitC(s),
          ...(s.indexValue ? [`  o->${OVERFLOW_MEMBER} = ${overflowNewC(s)};`] : []),
          `  scr_obj_alloc_note();`,
          `  return o;`,
          `}`,
          ...(s.recordId !== undefined && E.recordCloneShapes.has(s.recordId)
            ? emitRecordCloneC(s.recordId, s.struct, s.fields, s.newFn)
            : []),
          `static void *${s.retain}_v(void *o) { return ${s.retain}((${s.struct} *)o); }`,
          `static void ${s.release}_v(void *o) { ${s.release}((${s.struct} *)o); }`,
          ``,
        );
        continue;
      }
      // Cycle-capable shape: cycle-headered allocation, root-buffer hooks
      // on release, and the trace/teardown complement pair.
      const tracedFields = rcMembers(s).filter((m) => E.traceAdapterC(m.type) !== null);
      const untracedRefFields = rcMembers(s).filter(
        (m) => isRefCounted(m.type) && E.traceAdapterC(m.type) === null,
      );
      out.push(
        `static ${s.struct} *${s.retain}(${s.struct} *o) {`,
        `  if (o && o->rc != SIZE_MAX) {`,
        `    o->rc++;`,
        `    scr_cyc_mark_live(o);`,
        `  }`,
        `  return o;`,
        `}`,
        `static void ${s.release}(${s.struct} *o) {`,
        `  if (!o || o->rc == SIZE_MAX) return;`,
        `  if (--o->rc == 0) {`,
        `    scr_cyc_on_dead(o);`,
      );
      for (const m of rcMembers(s)) {
        if (!isRefCounted(m.type)) continue;
        const field = `o->${m.member}`;
        out.push(`    if (${field}) ${releaseCallC(m.type, field)};`);
      }
      out.push(
        `    scr_obj_free_note();`,
        `    scr_cyc_free(o);`,
        `  } else {`,
        `    scr_cyc_on_release(o); /* possible cycle root; may collect */`,
        `  }`,
        `}`,
        `static ${s.struct} *${s.newFn}(void) {`,
        `  ${s.struct} *o = scr_cyc_alloc(sizeof *o, &${s.trace}, &${s.gcFree});`,
        `  o->rc = 1;`,
        ...undefFieldInitC(s),
        ...(s.indexValue ? [`  o->${OVERFLOW_MEMBER} = ${overflowNewC(s)};`] : []),
        `  scr_obj_alloc_note();`,
        `  return o;`,
        `}`,
        ...(s.recordId !== undefined && E.recordCloneShapes.has(s.recordId)
          ? emitRecordCloneC(s.recordId, s.struct, s.fields, s.newFn)
          : []),
        `static void ${s.trace}(void *o0, ScrTraceVisit visit, void *ctx) {`,
        `  ${s.struct} *o = (${s.struct} *)o0;`,
        ...tracedFields.map(
          (m) => `  visit(o->${m.member}, ctx); /* ${m.name} */`,
        ),
        `}`,
        `static void ${s.gcFree}(void *o0) {`,
        ...(untracedRefFields.length > 0
          ? [
              `  ${s.struct} *o = (${s.struct} *)o0;`,
              ...untracedRefFields.map((m) => {
                const field = `o->${m.member}`;
                return `  if (${field}) ${releaseCallC(m.type, field)}; /* ${m.name} (acyclic) */`;
              }),
            ]
          : []),
        `  scr_obj_free_note();`,
        `  scr_cyc_free(o0);`,
        `}`,
        `static void *${s.retain}_v(void *o) { return ${s.retain}((${s.struct} *)o); }`,
        `static void ${s.release}_v(void *o) { ${s.release}((${s.struct} *)o); }`,
        ``,
      );
    }
  }

/** One deliberately non-inlined same-shape clone helper. Keeping the copy
 * here makes each `{ ...largeRecord, override }` site constant-sized while
 * preserving the ordinary type-directed retain rules. */
function emitRecordCloneC(
  shapeId: string,
  struct: string,
  fields: { name: string; type: IrType }[],
  newFn: string,
): string[] {
  const noinline = fields.length >= 16;
  return [
    ...(noinline
      ? [
          `#if defined(_MSC_VER)`,
          `__declspec(noinline)`,
          `#else`,
          `__attribute__((noinline))`,
          `#endif`,
        ]
      : []),
    `static ${struct} *${mangleRecordClone(shapeId)}(${struct} *src) {`,
    `  ${struct} *o = ${newFn}();`,
    ...fields.map((f) => {
      const member = mangleField(f.name);
      return `  o->${member} = ${isRefCounted(f.type) ? retainCallC(f.type, `src->${member}`) : `src->${member}`};`;
    }),
    `  return o;`,
    `}`,
  ];
}

/** The root's slot list as seen by one class: the implementation the
   * class dispatches to, or null outside the slot's declaring subtree (a
   * call through this class's vtable can never reach that slot). An
   * ABSTRACT class whose chain holds only abstract declarations of the
   * slot also answers null — the class never instantiates (tsc), so its
   * own vtable entry can never dispatch. */
  export function vtEntriesFor(E: CEmitter, meta: ClassMeta): { slot: VtSlot; impl: ClassMeta | null }[] {
    return meta.root.slots.map((slot) => {
      if (!(slot.declarer.pre <= meta.pre && meta.pre <= slot.declarer.post)) {
        return { slot, impl: null };
      }
      for (let c: ClassMeta | null = meta; c; c = c.base) {
        if (c.def.methods?.includes(slot.method) && !c.def.abstractMethods?.includes(slot.method)) {
          return { slot, impl: c };
        }
      }
      if (meta.def.abstract === true) return { slot, impl: null };
      throw new Error(`emitter bug: no implementation of ${slot.method} for ${meta.def.name}`);
    });
  }

/** The C parameter list of a slot (declaring-class `this` first). */
  export function vtSlotParams(E: CEmitter, slot: VtSlot, named: boolean): string[] {
    const thisParam = named
      ? `${mangleClassStruct(slot.declarer.def.name)} *o`
      : `${mangleClassStruct(slot.declarer.def.name)} *`;
    const rest = slot.fn.params
      .slice(1)
      .map((p, i) => (named ? cDecl(p.type, `sc_a${i}`) : cType(p.type).trim()));
    return [thisParam, ...rest];
  }

/** Vtable struct typedefs + adapter prototypes (the definitions call
   * function bodies, so they flush after the signature block — see emit). */
  export function emitVtableDecls(E: CEmitter, out: string[], hierarchyClasses: ClassMeta[]): void {
    // Roots of the EMITTED classes' hierarchies — a runtime root (%Error)
    // counts exactly when some emitted subclass needs its vtable type.
    const roots = [...new Set(hierarchyClasses.map((m) => m.root))];
    for (const root of roots) {
      const vtt = mangleVtStruct(root.def.name);
      out.push(`typedef struct ${vtt} { /* vtable: hierarchy rooted at ${root.def.name} */`);
      out.push(`  ScrVt head;`);
      for (const slot of root.slots) {
        const ret = cType(slot.fn.returnType).trim();
        out.push(
          `  ${ret} (*${slot.member})(${E.vtSlotParams(slot, false).join(", ")}); /* ${slot.method} */`,
        );
      }
      out.push(`} ${vtt};`);
    }
    if (roots.length > 0) out.push("");
    for (const meta of hierarchyClasses) {
      for (const { slot, impl } of E.vtEntriesFor(meta)) {
        if (impl === null) continue;
        const key = `${impl.def.name}.${slot.method}`;
        if (E.vtAdapters.has(key)) continue;
        E.vtAdapters.set(key, { impl, slot });
        const ret = cType(slot.fn.returnType).trim();
        out.push(
          `static ${ret} ${mangleVtAdapter(impl.def.name, slot.method)}(${E.vtSlotParams(slot, false).join(", ")});`,
        );
      }
    }
    if (E.vtAdapters.size > 0) out.push("");
  }

/** One static const vtable per hierarchy class: interval, direct
   * release, and the class's dispatch entry for every slot. */
  export function emitVtableInstances(E: CEmitter, out: string[], hierarchyClasses: ClassMeta[]): void {
    for (const meta of hierarchyClasses) {
      const vtt = mangleVtStruct(meta.root.def.name);
      const head = `{ ${meta.pre}, ${meta.post}, &${mangleClassReleaseDirect(meta.def.name)} }`;
      const entries = E.vtEntriesFor(meta).map(({ slot, impl }) =>
        impl === null
          ? `0 /* ${slot.method}: outside the declaring subtree */`
          : `&${mangleVtAdapter(impl.def.name, slot.method)} /* ${slot.method} */`,
      );
      out.push(
        `static const ${vtt} ${mangleVtInstance(meta.def.name)} = { /* class ${meta.def.name} */`,
        `  ${[head, ...entries].join(",\n  ")}`,
        `};`,
      );
    }
    if (hierarchyClasses.length > 0) out.push("");
  }

/** Adapter definitions (flushed after the signature block): the impl
   * class's method behind the slot's declaring-class signature. */
  export function emitVtAdapterDefs(E: CEmitter, out: string[]): void {
    for (const { impl, slot } of E.vtAdapters.values()) {
      const ret = cType(slot.fn.returnType).trim();
      const recv =
        impl === slot.declarer ? "o" : `(${mangleClassStruct(impl.def.name)} *)o`;
      const args = [recv, ...slot.fn.params.slice(1).map((_, i) => `sc_a${i}`)].join(", ");
      const call = `${mangleFunction(`%${impl.def.name}.${slot.method}`)}(${args})`;
      out.push(
        ``,
        `static ${ret} ${mangleVtAdapter(impl.def.name, slot.method)}(${E.vtSlotParams(slot, true).join(", ")}) {`,
        slot.fn.returnType.kind === "void" ? `  ${call};` : `  return ${call};`,
        `}`,
      );
    }
  }

/** RC helpers of one hierarchy class. Retain is layout-generic (rc sits
   * at offset 0 in every subclass); the PUBLIC release dispatches through
   * the object's vtable so a base-typed release tears down the derived
   * object; the DIRECT release (the vtable entry) does the class's own
   * teardown. Cycle capability is hierarchy-uniform (constructor fixpoint),
   * and the cycle header's trace/teardown are stamped with the concrete
   * class's functions at allocation — the collector needs no vtable. */
  export function emitHierarchyClassHelpers(E: CEmitter, out: string[],
    meta: ClassMeta,
    s: {
      struct: string;
      newFn: string;
      retain: string;
      release: string;
      trace: string;
      gcFree: string;
      traced: boolean;
      fields: { name: string; type: IrType }[];
    },): void {
    const reld = mangleClassReleaseDirect(meta.def.name);
    const emitterRooted = meta.root.def.name === RUNTIME_EMITTER_CLASS;
    const isStreamRooted = streamRooted(meta);
    // The display name Node's leak warning prints ([My]) — the source
    // class name, without the module qualifier.
    const displayName = meta.def.name.includes(".")
      ? meta.def.name.slice(meta.def.name.lastIndexOf(".") + 1)
      : meta.def.name;
    out.push(
      `static ${s.struct} *${s.retain}(${s.struct} *o) {`,
      ...(s.traced
        ? [`  if (o && o->rc != SIZE_MAX) {`, `    o->rc++;`, `    scr_cyc_mark_live(o);`, `  }`]
        : [`  if (o && o->rc != SIZE_MAX) o->rc++;`]),
      `  return o;`,
      `}`,
      `static void ${s.release}(${s.struct} *o) {`,
      `  if (!o || o->rc == SIZE_MAX) return;`,
      `  o->vt->release(o); /* the DYNAMIC class's teardown */`,
      `}`,
      `static void ${reld}(void *o0) {`,
      `  ${s.struct} *o = (${s.struct} *)o0;`,
      `  if (--o->rc == 0) {`,
      ...(s.traced ? [`    scr_cyc_on_dead(o);`] : []),
    );
    for (const f of s.fields) {
      if (!isRefCounted(f.type)) continue;
      const field = `o->${mangleField(f.name)}`;
      out.push(`    if (${field}) ${releaseCallC(f.type, field)};`);
    }
    if (emitterRooted) {
      out.push(`    scr_emitter_reg_drop(o->sc_eereg); /* EventEmitter prefix */`);
      if (isStreamRooted) {
        out.push(`    scr_stream_st_release(o->sc_st); /* stream state (ScrStream prefix) */`);
      }
    }
    out.push(
      `    scr_obj_free_note();`,
      s.traced ? `    scr_cyc_free(o);` : `    free(o);`,
      ...(s.traced
        ? [`  } else {`, `    scr_cyc_on_release(o); /* possible cycle root; may collect */`, `  }`]
        : [`  }`]),
      `}`,
      `static ${s.struct} *${s.newFn}(void) {`,
      ...(s.traced
        ? [`  ${s.struct} *o = scr_cyc_alloc(sizeof *o, &${s.trace}, &${s.gcFree});`]
        : [
            `  ${s.struct} *o = calloc(1, sizeof *o);`,
            `  if (!o) { scr_trap("scriptc: out of memory\\n"); }`,
          ]),
      `  o->rc = 1;`,
      `  o->vt = &${mangleVtInstance(meta.def.name)}.head;`,
      ...(emitterRooted
        ? [`  o->sc_eecls = ${JSON.stringify(displayName)}; /* EventEmitter prefix (reg stays NULL) */`]
        : []),
      // Undefined-admitting fields start as JS's undefined, not NULL — see
      // undefFieldInitLineC. s.fields is the FLATTENED layout (base prefix
      // + own), so a derived allocation covers inherited fields too.
      ...s.fields.flatMap((f) => E.undefFieldInitLineC(f.name, f.type)),
      `  scr_obj_alloc_note();`,
      `  return o;`,
      `}`,
    );
    if (s.traced) {
      const tracedFields = s.fields.filter((f) => E.traceAdapterC(f.type) !== null);
      const untracedRefFields = s.fields.filter(
        (f) => isRefCounted(f.type) && E.traceAdapterC(f.type) === null,
      );
      out.push(
        `static void ${s.trace}(void *o0, ScrTraceVisit visit, void *ctx) {`,
        `  ${s.struct} *o = (${s.struct} *)o0;`,
        ...(emitterRooted
          ? [`  scr_emitter_reg_trace(o->sc_eereg, visit, ctx); /* listener closures */`]
          : []),
        ...(isStreamRooted
          ? [`  scr_stream_st_trace(o->sc_st, visit, ctx); /* stream state closures/pipes */`]
          : []),
        ...tracedFields.map((f) => `  visit(o->${mangleField(f.name)}, ctx); /* ${f.name} */`),
        `}`,
        `static void ${s.gcFree}(void *o0) {`,
        ...(untracedRefFields.length > 0 || emitterRooted
          ? [`  ${s.struct} *o = (${s.struct} *)o0;`]
          : []),
        ...(emitterRooted
          ? [`  scr_emitter_reg_gcfree(o->sc_eereg); /* EventEmitter prefix */`]
          : []),
        ...(isStreamRooted
          ? [`  scr_stream_st_gcfree(o->sc_st); /* stream state (ScrStream prefix) */`]
          : []),
        ...untracedRefFields.map((f) => {
          const field = `o->${mangleField(f.name)}`;
          return `  if (${field}) ${releaseCallC(f.type, field)}; /* ${f.name} (acyclic) */`;
        }),
        `  scr_obj_free_note();`,
        `  scr_cyc_free(o0);`,
        `}`,
      );
    }
    out.push(
      `static void *${s.retain}_v(void *o) { return ${s.retain}((${s.struct} *)o); }`,
      `static void ${s.release}_v(void *o) { ${s.release}((${s.struct} *)o); }`,
      ``,
    );
  }

/** Class objects (classes as first-class values): one immortal
   * ScrClassObj static per class some classRef in the module names, plus
   * the construct-thunk PROTOTYPES their `ctor` slots take the address of
   * (definitions land later with the other synthesized bodies —
   * emitCtorThunkDefs). The interval constants are the same numbering the
   * vtables carry, so instanceOfValue agrees with compiled instanceOf. */
  export function emitClassObjs(E: CEmitter, out: string[]): void {
    if (E.classObjs.size === 0) return;
    out.push("");
    for (const [className, sym] of E.classObjs) {
      const meta = E.classMeta.get(className);
      if (!meta) throw new Error(`emitter bug: class object for unknown class ${className}`);
      // A generic-class INSTANTIATION's class object carries its FAMILY's
      // interval: at runtime JS has ONE `Box`, so instanceof through the
      // value must answer for the whole family (every instantiation and
      // their subclasses) — IrClassDef.genericOf. Construction still
      // dispatches the instantiation's own thunk.
      const intervalMeta = meta.def.genericOf !== undefined
        ? E.classMeta.get(meta.def.genericOf)
        : meta;
      if (!intervalMeta) throw new Error(`emitter bug: class object for ${className} names unknown family ${meta.def.genericOf ?? ""}`);
      const nameSym = E.internLiteral(meta.def.jsName ?? "");
      out.push(
        `static void *${mangleCtorThunk(className)}(${ctorThunkParams(E, className).decls || "void"});`,
        `static ScrClassObj ${sym} = { SIZE_MAX, ${intervalMeta.pre}, ${intervalMeta.post}, ` +
          `(void *)&${mangleCtorThunk(className)}, (const ScrStr *)&${nameSym} }; /* class ${className} */`,
      );
    }
  }

/** The construct thunk's parameter list: the constructor's completed ABI
   * minus the `this` the thunk allocates itself. */
  function ctorThunkParams(E: CEmitter, className: string): { decls: string; names: string[] } {
    const ctor = E.fnByName.get(`%${className}.constructor`);
    if (!ctor) throw new Error(`emitter bug: class object for ${className} without a constructor`);
    const params = ctor.params.slice(1);
    return {
      decls: params.map((p, i) => cDecl(p.type, `sc_a${i}`)).join(", "),
      names: params.map((_, i) => `sc_a${i}`),
    };
  }

/** Construct-thunk definitions (`void *sc_ct_C(args…)`): allocate, run
   * the constructor over a +1 `this` like the inline `new` emission, and
   * hand the remaining +1 out as `void *` — the one well-defined
   * function-pointer shape every class in a classval slot shares (the
   * frontend's ABI flow rule makes the parameter lists agree). A throwing
   * constructor leaves the pending flag set: the thunk releases the
   * half-built object and returns NULL (a dummy the checked call site
   * never reads). */
  export function emitCtorThunkDefs(E: CEmitter, out: string[]): void {
    for (const className of E.classObjs.keys()) {
      const { decls, names } = ctorThunkParams(E, className);
      const struct = mangleClassStruct(className);
      const lines = [
        ``,
        `static void *${mangleCtorThunk(className)}(${decls || "void"}) {`,
        `  ${struct} *o = ${mangleClassNew(className)}();`,
        `  ${mangleFunction(`%${className}.constructor`)}(${[`${mangleClassRetain(className)}(o)`, ...names].join(", ")});`,
      ];
      if (E.mayThrow.has(`%${className}.constructor`)) {
        lines.push(
          `  if (scr_exc_pending()) {`,
          `    ${mangleClassRelease(className)}(o);`,
          `    return NULL;`,
          `  }`,
        );
      }
      lines.push(`  return (void *)o;`, `}`);
      out.push(...lines);
    }
  }

/** main()'s stamping of the runtime error vtables: preorder intervals
   * from THIS module's numbering, plus the traced-mode switch when the
   * cycle fixpoint marked the Error hierarchy (a user subclass holds
   * cycle-capable fields — capability is hierarchy-uniform, so the
   * runtime's own allocations need collector headers too). Empty for
   * hand-written IR without the builtin defs. */
  export function errorVtStampLines(E: CEmitter): string[] {
    const lines: string[] = [];
    for (const [name, rec] of RUNTIME_ERROR_CLASSES) {
      const meta = E.classMeta.get(name);
      if (!meta) return [];
      lines.push(
        `  scr_error_vts[${rec.kind}].pre = ${meta.pre}; scr_error_vts[${rec.kind}].post = ${meta.post}; /* ${rec.lib} */`,
      );
    }
    if (E.tracedShapes.has("object:%Error")) {
      lines.push(`  scr_error_set_traced();`);
    }
    return lines;
  }

/** main()'s stamping of the runtime emitter vtable: its preorder
   * interval from THIS module's numbering (the errorVtStampLines story).
   * Empty when the program never touches the emitter surface — the class
   * def only rides modules that reference it. */
  export function emitterVtStampLines(E: CEmitter): string[] {
    const meta = E.classMeta.get(RUNTIME_EMITTER_CLASS);
    if (!meta) return [];
    return [
      `  scr_emitter_vt.pre = ${meta.pre}; scr_emitter_vt.post = ${meta.post}; /* EventEmitter */`,
    ];
  }

/** main()'s stamping of the runtime stream vtables (Readable/Writable/
   * Duplex/Transform/PassThrough) — the emitterVtStampLines story: each
   * def rides the module only when the program touches the stream
   * surface, and instanceof needs their preorder intervals under the
   * emitter root. */
  export function streamVtStampLines(E: CEmitter): string[] {
    const lines: string[] = [];
    for (const [name, rec] of RUNTIME_STREAM_CLASSES) {
      const meta = E.classMeta.get(name);
      if (!meta) continue;
      const vt = `scr_${rec.lib.toLowerCase()}_vt`;
      lines.push(`  ${vt}.pre = ${meta.pre}; ${vt}.post = ${meta.post}; /* ${rec.lib} */`);
    }
    return lines;
  }

/** The trace entry point symbol for a payload/field type, or null when
   * the type cannot participate in a cycle (see the constructor fixpoint). */
  export function traceAdapterC(E: CEmitter, t: IrType): string | null {
    switch (t.kind) {
      case "func":
        return "scr_closure_trace_v";
      case "union":
        return E.tracedUnions.has(t.unionId) ? "scr_union_trace_v" : null;
      case "promise":
        return "scr_promise_trace_v";
      case "object":
        if (!E.tracedShapes.has(`object:${t.className}`)) return null;
        if (RUNTIME_ERROR_CLASSES.has(t.className)) return "scr_error_trace";
        if (t.className === RUNTIME_EMITTER_CLASS) return "scr_emitter_trace";
        if (RUNTIME_STREAM_CLASSES.has(t.className)) return "scr_stream_trace";
        return mangleClassTrace(t.className);
      case "record":
        return E.tracedShapes.has(`record:${t.shapeId}`) ? mangleRecordTrace(t.shapeId) : null;
      // Cycle-capable exactly when the VALUE type is (mirrors the
      // constructor fixpoint's map rule): such maps allocate with the
      // collector header and their runtime trace visits every live value.
      case "map":
        return E.traceAdapterC(t.value) !== null ? "scr_map_trace_v" : null;
      // Arrays mirror maps: cycle-capable exactly when the ELEMENT type is
      // (a record/object/union element — or a cycle-capable inner array —
      // can point back at the array holding it). Such arrays allocate with
      // the collector header (scr_arr_new_ref with a trace); scalar/
      // string/bytes-element arrays stay lean.
      case "array":
        return E.traceAdapterC(t.elem) !== null ? "scr_arr_trace_v" : null;
      default:
        return null;
    }
  }

/** `&<trace>` or `NULL` — the trace argument at a container call site. */
  export function traceArgC(E: CEmitter, t: IrType): string {
    const sym = E.traceAdapterC(t);
    return sym ? `&${sym}` : "NULL";
  }

/** Array construction expression for one element type. Ref elements
   * (records, class instances, unions — and cycle-capable inner arrays,
   * whose SCR_ELEM_ARR spelling would hide them from the outer array's
   * trace) construct through scr_arr_new_ref, which stores the element
   * type's RC entry points once per array (the map-value technique) and
   * allocates with the collector header exactly when the element type
   * carries one (trace non-NULL). Every other element kind keeps the
   * historic scr_arr_new call. */
  export function arrNewC(E: CEmitter, elem: IrType, capExpr: string | number): string {
    const useRef =
      elem.kind === "record" || elem.kind === "object" || elem.kind === "union" ||
      // Promise elements (Promise.all's food): refcounted, cycle-headered
      // — the `_v` adapters and scr_promise_trace_v ride the same REF
      // machinery as record/object/union elements.
      elem.kind === "promise" ||
      elem.kind === "jsval" || // island handles: scr_jsval_* adapters, no trace
      elem.kind === "regex" || // RegExp values: scr_regex_* adapters, no trace (no refs inside)
      elem.kind === "child" || // spawned child handles: scr_child_* adapters, no trace
      elem.kind === "netServer" || // server handles: scr_net_server_* adapters, no trace
      elem.kind === "symbol" || // symbol identities: scr_sym_* adapters, no trace
      elem.kind === "classval" || // class objects: no-op adapters, no trace (immortal statics)
      // Closures: scr_closure_* adapters + scr_closure_trace_v (always
      // cycle-headered — captures can reach back through boxes).
      elem.kind === "func" ||
      (elem.kind === "array" && E.traceAdapterC(elem) !== null);
    if (!useRef) return `scr_arr_new(${elemKindC(elem)}, ${capExpr})`;
    const v = vAdapters(elem);
    return `scr_arr_new_ref(&${v.retain}, &${v.release}, ${E.traceArgC(elem)}, ${capExpr})`;
  }

/** Box construction expression — object/record/union/promise boxes carry
   * their RC entry points (and the payload's trace) as function pointers
   * (the SCR_BOX_OBJ mechanism: the runtime can't know per-shape layouts). */
  export function boxNewC(E: CEmitter, t: IrType): string {
    // A captured local can be typed by a class the module never collected
    // (a runtime-fenced JS class — e.g. one declared inside a block —
    // whose declaration and every use compile to runtime traps): no
    // instance can ever exist, so the box is an inert placeholder — its
    // RC adapters were never emitted and must not be referenced.
    if (t.kind === "object" && !E.classMeta.has(t.className)) {
      return `scr_box_new(SCR_BOX_F64) /* ${t.className}: uncollected class, all uses trap */`;
    }
    if (
      t.kind === "object" || t.kind === "record" || t.kind === "union" ||
      t.kind === "classval" ||
      t.kind === "map" || t.kind === "set" || t.kind === "promise" ||
      t.kind === "generator" ||
      t.kind === "regex" || t.kind === "url" || t.kind === "searchParams" ||
      t.kind === "symbol" || t.kind === "stats" ||
      t.kind === "fileHandle" ||
      t.kind === "spawnRes" || t.kind === "child" || t.kind === "bytes" ||
      t.kind === "netServer" || t.kind === "netSocket" ||
      t.kind === "http2Session" || t.kind === "http2Stream" ||
      t.kind === "dgramSocket" || t.kind === "testCtx" ||
      t.kind === "httpReq" || t.kind === "httpRes" ||
      t.kind === "httpClientReq" || t.kind === "secureCtx" ||
      t.kind === "fsWatcher" || t.kind === "childStream" ||
      // Island handles: the box carries scr_jsval_retain_v/release_v and
      // no trace — the same stance as jsval array elements.
      t.kind === "jsval" ||
      // Checked-dynamic captures (the mustCall wrapper closing over its
      // implicit-any `fn` param): the box carries scr_dyn_retain_v/
      // release_v and NO trace — a dyn tree is pure data except the
      // function kind, whose closure edge stays invisible to the
      // collector (trial deletion treats it as an external root: cycles
      // through dyn never collect, nothing dangles — SEMANTICS.md).
      t.kind === "dyn" ||
      // A CYCLE-CAPABLE array must ride the obj-box so the box's trace
      // reaches it (SCR_BOX_ARR payloads are never traced); acyclic arrays
      // keep the historic plain-kind box below.
      (t.kind === "array" && E.traceAdapterC(t) !== null)
    ) {
      const v = vAdapters(t);
      return `scr_box_new_obj(&${v.retain}, &${v.release}, ${E.traceArgC(t)})`;
    }
    return `scr_box_new(${boxKindC(t)})`;
  }
