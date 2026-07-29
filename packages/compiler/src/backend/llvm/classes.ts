/* The LLVM backend's class machinery — the .ll mirror of the C emitter's
 * class slice (emit-shapes.ts): the class graph (base/children links, the
 * whole-program preorder numbering behind O(1) instanceof, hierarchy
 * membership, per-hierarchy virtual slot lists), per-class struct types and
 * RC/trace helper families, the hierarchy vtable instances, and the class
 * objects (classes as first-class values) with their construct thunks.
 *
 * Two deliberate simplifications over the C emission, both possible because
 * every pointer is `ptr` in LLVM:
 * - NO vtable slot adapters: the C backend needs sc_vm_* thunks because a
 *   slot's function-pointer TYPE spells the declaring class's `this`; here
 *   every implementation already has the slot's exact LLVM signature
 *   (override exactness fixes the ABI), so the vtable stores the method
 *   function directly.
 * - ONE struct spelling per class (%sc_o_*); the runtime error classes GEP
 *   through the emitter-declared %ScrError instead (their structs live in
 *   the runtime).
 *
 * Emitter- and stream-rooted classes stay out of the tier (their prefixes
 * embed runtime registry/state slots and their surfaces are async-shaped);
 * the emitter refuses them by name before anything here runs. */
import type { IrClassDef, IrFunction, IrModule, IrType } from "../../ir/nodes.js";
import { isRefCounted, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES } from "../../ir/nodes.js";
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
  mangleVtInstance,
  mangleVtStruct,
} from "../mangle.js";
import { FN_ATTRS, llFieldType, releaseSym, traceAdapter, type ShapeHost } from "./shapes.js";

/** One virtual method slot of a hierarchy: the ROOT-MOST declaring class
 * owns the slot; its declaration's IrFunction fixes the slot's ABI (the
 * frontend's override exactness makes every implementation identical). */
export interface LlVtSlot {
  method: string;
  declarer: LlClassMeta;
  fn: IrFunction;
}

/** Per-class node of the class graph — the CEmitter ClassMeta shape. */
export interface LlClassMeta {
  def: IrClassDef;
  base: LlClassMeta | null;
  children: LlClassMeta[];
  root: LlClassMeta;
  pre: number;
  post: number;
  hierarchy: boolean;
  /** Root classes: the hierarchy's slots in DFS-declaration order. */
  slots: LlVtSlot[];
}

/** The class graph: link base/children, number the forest in preorder
 * (roots and children in module class order — the SAME numbering the C
 * backend computes, so instanceof agrees between backends and with the
 * runtime's stamped error vtables), and compute each hierarchy's virtual
 * slots — a class's method gets a slot iff no ancestor declares it AND some
 * strict descendant redeclares it (whole-program devirtualization).
 * Ported from the CEmitter constructor. */
export function buildClassGraph(mod: IrModule, fnByName: Map<string, IrFunction>): Map<string, LlClassMeta> {
  const metaMap = new Map<string, LlClassMeta>();
  for (const cls of mod.classes ?? []) {
    metaMap.set(cls.name, {
      def: cls,
      base: null,
      children: [],
      root: undefined as unknown as LlClassMeta,
      pre: 0,
      post: 0,
      hierarchy: false,
      slots: [],
    });
  }
  for (const meta of metaMap.values()) {
    if (meta.def.base === undefined) continue;
    const base = metaMap.get(meta.def.base);
    if (!base) throw new Error(`llvm emitter bug: undeclared base class ${meta.def.base}`);
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
  const declares = (m: LlClassMeta, method: string): boolean => m.def.methods?.includes(method) ?? false;
  const declaredBelow = (m: LlClassMeta, method: string): boolean =>
    m.children.some((c) => declares(c, method) || declaredBelow(c, method));
  const collectSlots = (m: LlClassMeta, root: LlClassMeta): void => {
    for (const method of m.def.methods ?? []) {
      let inherited = false;
      for (let a = m.base; a; a = a.base) inherited ||= declares(a, method);
      if (!inherited && declaredBelow(m, method)) {
        let fn = fnByName.get(`%${m.def.name}.${method}`);
        if (!fn && m.def.abstractMethods?.includes(method)) {
          // Abstract declarer: the slot ABI comes from any concrete
          // descendant implementation; none anywhere means the slot can
          // never dispatch (only abstract classes declare it) — skip.
          const findImpl = (c: LlClassMeta): IrFunction | undefined => {
            for (const child of c.children) {
              const f = declares(child, method) && !child.def.abstractMethods?.includes(method)
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
        if (!fn) throw new Error(`llvm emitter bug: missing method function %${m.def.name}.${method}`);
        root.slots.push({ method, declarer: m, fn });
      }
    }
    for (const c of m.children) collectSlots(c, root);
  };
  for (const meta of metaMap.values()) {
    if (meta.base === null && meta.hierarchy) collectSlots(meta, meta);
  }
  return metaMap;
}

/** The root's slot list as seen by one class: the implementation the class
 * dispatches to, or null outside the slot's declaring subtree / on a
 * fully-abstract chain (vtEntriesFor, ported). */
export function vtEntriesFor(meta: LlClassMeta): { slot: LlVtSlot; impl: LlClassMeta | null }[] {
  return meta.root.slots.map((slot) => {
    if (!(slot.declarer.pre <= meta.pre && meta.pre <= slot.declarer.post)) {
      return { slot, impl: null };
    }
    for (let c: LlClassMeta | null = meta; c; c = c.base) {
      if (c.def.methods?.includes(slot.method) && !c.def.abstractMethods?.includes(slot.method)) {
        return { slot, impl: c };
      }
    }
    if (meta.def.abstract === true) return { slot, impl: null };
    throw new Error(`llvm emitter bug: no implementation of ${slot.method} for ${meta.def.name}`);
  });
}

/** The LLVM struct type name a class's instances GEP through: the runtime
 * error classes share the runtime's ScrError layout (emitted subclasses
 * embed it as their prefix); every emitted class has its own %sc_o_*. */
export function classStructSym(className: string): string {
  if (RUNTIME_ERROR_CLASSES.has(className)) return "ScrError";
  if (className === RUNTIME_EMITTER_CLASS) return "ScrEmitter";
  if (RUNTIME_STREAM_CLASSES.has(className)) return "ScrStream";
  return mangleClassStruct(className);
}

/** True when the class descends from the runtime emitter class: its
 * struct embeds ScrEmitter's remaining prefix (the registry pointer and
 * the display-name slot) after the vtable word, so an upcast to
 * ScrEmitter* is the usual pointer reinterpret (emit-shapes.ts's rule). */
export function emitterRooted(meta: LlClassMeta): boolean {
  return meta.root.def.name === RUNTIME_EMITTER_CLASS;
}

/** True when the class descends from a runtime STREAM class: its struct
 * embeds the FULL ScrStream prefix (registry, display name, state
 * pointer) and its RC/trace helpers delegate the state block to
 * scr_stream_st_* (emit-shapes.ts's streamRooted). */
export function streamRooted(meta: LlClassMeta): boolean {
  for (let m = meta.base; m; m = m.base) {
    if (RUNTIME_STREAM_CLASSES.has(m.def.name)) return true;
  }
  return false;
}

/** The GEP index where a class's own fields start: rc at 0, the vtable
 * word at 1 on hierarchy members, then the emitter prefix (registry +
 * display name) on emitter-rooted classes, then the stream-state slot on
 * stream-rooted ones. */
function fieldBase(meta: LlClassMeta): number {
  if (!meta.hierarchy) return 1;
  if (streamRooted(meta)) return 5;
  return emitterRooted(meta) ? 4 : 2;
}

/** A field's GEP index inside its class struct: rc at 0, the vtable word
 * at 1 on hierarchy members, then the flattened field list. */
export function classFieldIndex(meta: LlClassMeta, field: string): { index: number; type: IrType } {
  const idx = meta.def.fields.findIndex((f) => f.name === field);
  if (idx < 0) throw new Error(`llvm emitter bug: unknown field ${field} on class ${meta.def.name}`);
  return { index: fieldBase(meta) + idx, type: meta.def.fields[idx]!.type };
}

/** What class emission needs beyond ShapeHost: interned unit instances for
 * undefined-admitting field initialization (fields typed by an
 * undefined-armed union start as JS's `undefined`, never NULL), and the
 * interned NUL-terminated constants (emitter subclass display names). */
export interface ClassHost extends ShapeHost {
  unitInstanceRef(unionId: string, tag: number): string;
  undefinedArmTag(t: IrType): number;
  cstr(text: string): string;
}

/** The newFn initialization stores for fields whose type ADMITS undefined
 * (undefFieldInitLineC's LLVM twin): undefined-armed union fields start
 * at the interned unit instance; jsval fields (an `any` class field under
 * --dynamic) start at the engine's undefined cell. */
function undefFieldInits(host: ClassHost, meta: LlClassMeta): string[] {
  const out: string[] = [];
  meta.def.fields.forEach((f, i) => {
    const { index } = classFieldIndex(meta, f.name);
    if (f.type.kind === "jsval" || f.type.kind === "dyn") {
      const fn = f.type.kind === "jsval" ? "scr_jsval_undefined" : "scr_dyn_undefined";
      host.declare(`declare ptr @${fn}()`);
      out.push(
        `  %ufv${i} = call ptr @${fn}()`,
        `  %uf${i} = getelementptr inbounds %${mangleClassStruct(meta.def.name)}, ptr %o, i64 0, i32 ${index}`,
        `  store ptr %ufv${i}, ptr %uf${i} ; ${f.name} starts undefined`,
      );
      return;
    }
    if (f.type.kind !== "union") return;
    const tag = host.undefinedArmTag(f.type);
    if (tag < 0) return;
    out.push(
      `  %uf${i} = getelementptr inbounds %${mangleClassStruct(meta.def.name)}, ptr %o, i64 0, i32 ${index}`,
      `  store ptr ${host.unitInstanceRef(f.type.unionId, tag)}, ptr %uf${i} ; ${f.name} starts undefined`,
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
): { typeDefs: string[]; defs: string[] } {
  const typeDefs: string[] = [];
  const defs: string[] = [];
  const emitted = (mod.classes ?? []).filter((c) => !c.runtime);
  if (emitted.length === 0) return { typeDefs, defs };
  host.declare(`declare void @scr_obj_alloc_note()`);
  host.declare(`declare void @scr_obj_free_note()`);

  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    const fieldTys = cls.fields.map((f) => llFieldType(f.type));
    // Emitter subclasses embed ScrEmitter's remaining prefix (the registry
    // and display-name slots) between the vtable word and the field list;
    // stream subclasses add the state pointer — upcasts to ScrEmitter* /
    // ScrStream* are the usual pointer reinterprets.
    const prefix = meta.hierarchy
      ? streamRooted(meta) ? ["ptr", "ptr", "ptr", "ptr"]
      : emitterRooted(meta) ? ["ptr", "ptr", "ptr"]
      : ["ptr"]
      : [];
    const members = [...prefix, ...fieldTys];
    typeDefs.push(
      `%${mangleClassStruct(cls.name)} = type { i64${members.length ? ", " + members.join(", ") : ""} } ` +
        `; class ${cls.name}${meta.hierarchy ? " (vt at 1)" : ""}${streamRooted(meta) ? " (ScrStream prefix at 2)" : emitterRooted(meta) ? " (ScrEmitter prefix at 2)" : ""} { ${cls.fields.map((f) => f.name).join("; ")} }`,
    );
  }

  // Vtable struct types, one per ROOT of the emitted hierarchy classes (a
  // runtime root — %Error — counts exactly when an emitted subclass needs
  // its type): a ScrVt head plus one ptr per slot. All slots are `ptr`, so
  // the type is layout-only.
  const roots = [...new Set(emitted.map((c) => metaMap.get(c.name)!).filter((m) => m.hierarchy).map((m) => m.root))];
  for (const root of roots) {
    const slotPtrs = root.slots.map(() => "ptr").join(", ");
    typeDefs.push(
      `%${mangleVtStruct(root.def.name)} = type { %ScrVt${root.slots.length ? ", " + slotPtrs : ""} } ` +
        `; vtable: hierarchy rooted at ${root.def.name}${root.slots.length ? ` [${root.slots.map((s) => s.method).join(", ")}]` : ""}`,
    );
  }

  // One constant vtable instance per emitted hierarchy class: interval,
  // direct release, and the class's dispatch entry for every slot — the
  // method functions THEMSELVES (no adapters; see the header comment).
  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    if (!meta.hierarchy) continue;
    const entries = vtEntriesFor(meta).map(({ slot, impl }) =>
      impl === null
        ? `ptr null` // outside the declaring subtree / fully-abstract chain
        : `ptr @${mangleFunction(`%${impl.def.name}.${slot.method}`)}`,
    );
    const head = `%ScrVt { i64 ${meta.pre}, i64 ${meta.post}, ptr @${mangleClassReleaseDirect(cls.name)} }`;
    defs.push(
      `@${mangleVtInstance(cls.name)} = internal constant %${mangleVtStruct(meta.root.def.name)} ` +
        `{ ${[head, ...entries].join(", ")} } ; class ${cls.name}`,
      ``,
    );
  }

  for (const cls of emitted) {
    const meta = metaMap.get(cls.name)!;
    const struct = mangleClassStruct(cls.name);
    const traced = host.tracedShapes.has(`object:${cls.name}`);
    const isEmitterRooted = emitterRooted(meta);
    const isStreamRooted = streamRooted(meta);
    const fieldIndex = (i: number): number => fieldBase(meta) + i;
    const refFields = cls.fields
      .map((f, i) => ({ ...f, index: fieldIndex(i) }))
      .filter((f) => isRefCounted(f.type));
    const sizeOf = `ptrtoint (ptr getelementptr (%${struct}, ptr null, i32 1) to i64)`;
    // An embedded prefix slot (the emitter registry at 2, the stream
    // state at 4) handed to one of the runtime's prefix helpers —
    // teardown/trace/collector.
    const prefixCall = (tag: string, slot: number, entry: string, tail: string, what: string): string[] => {
      host.declare(`declare void @${entry}(ptr${tail ? ", ptr, ptr" : ""})`);
      return [
        `  %${tag}p = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${slot}`,
        `  %${tag}v = load ptr, ptr %${tag}p`,
        `  call void @${entry}(ptr %${tag}v${tail}) ; ${what}`,
      ];
    };
    const regCall = (tag: string, entry: string, tail: string): string[] =>
      prefixCall(tag, 2, entry, tail, "EventEmitter prefix");
    const stCall = (tag: string, entry: string, tail: string): string[] =>
      prefixCall(tag, 4, entry, tail, "stream state (ScrStream prefix)");

    // retain: NULL-tolerant, immortal-skip, mark-live on traced shapes —
    // layout-generic (rc at 0), so hierarchy members need no dispatch.
    defs.push(
      `define internal ptr @${mangleClassRetain(cls.name)}(ptr %o) ${FN_ATTRS} { ; retain ${cls.name}`,
      `entry:`,
      `  %isnull = icmp eq ptr %o, null`,
      `  br i1 %isnull, label %done, label %check`,
      `check:`,
      `  %rc = load i64, ptr %o`,
      `  %imm = icmp eq i64 %rc, -1`,
      `  br i1 %imm, label %done, label %inc`,
      `inc:`,
      `  %n = add i64 %rc, 1`,
      `  store i64 %n, ptr %o`,
      ...(traced
        ? [`  %colorp = getelementptr i8, ptr %o, i64 -16`, `  store i32 0, ptr %colorp ; mark live`]
        : []),
      `  br label %done`,
      `done:`,
      `  ret ptr %o`,
      `}`,
      ``,
    );

    // The field-releasing teardown body shared by both release shapes
    // (the public one on standalone classes, the DIRECT one on hierarchy
    // members). Runs at rc == 0.
    const teardown = (lines: string[]): void => {
      if (traced) {
        host.declare(`declare void @scr_cyc_on_dead(ptr)`);
        lines.push(`  call void @scr_cyc_on_dead(ptr %o)`);
      }
      refFields.forEach((f, t) => {
        lines.push(
          `  %f${t} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
          `  %v${t} = load ptr, ptr %f${t}`,
          `  call void ${releaseSym(host, f.type)}(ptr %v${t}) ; ${f.name}`,
        );
      });
      if (isEmitterRooted) lines.push(...regCall("td", "scr_emitter_reg_drop", ""));
      if (isStreamRooted) lines.push(...stCall("tds", "scr_stream_st_release", ""));
      lines.push(`  call void @scr_obj_free_note()`);
      if (traced) {
        host.declare(`declare void @scr_cyc_free(ptr)`);
        lines.push(`  call void @scr_cyc_free(ptr %o)`);
      } else {
        host.declare(`declare void @free(ptr)`);
        lines.push(`  call void @free(ptr %o)`);
      }
    };

    if (meta.hierarchy) {
      // Public release: NULL/immortal checks, then dispatch through the
      // object's vtable so a base-typed release tears down the DERIVED
      // object (scr_error_release's contract exactly).
      defs.push(
        `define internal void @${mangleClassRelease(cls.name)}(ptr %o) ${FN_ATTRS} { ; release ${cls.name} (dispatches)`,
        `entry:`,
        `  %isnull = icmp eq ptr %o, null`,
        `  br i1 %isnull, label %done, label %check`,
        `check:`,
        `  %rc = load i64, ptr %o`,
        `  %imm = icmp eq i64 %rc, -1`,
        `  br i1 %imm, label %done, label %disp`,
        `disp:`,
        `  %vtp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 1`,
        `  %vt = load ptr, ptr %vtp`,
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
      // caller already handled NULL/immortal.
      const reld: string[] = [
        `define internal void @${mangleClassReleaseDirect(cls.name)}(ptr %o) ${FN_ATTRS} { ; direct release ${cls.name}`,
        `entry:`,
        `  %rc = load i64, ptr %o`,
        `  %n = sub i64 %rc, 1`,
        `  store i64 %n, ptr %o`,
        `  %dead = icmp eq i64 %n, 0`,
        `  br i1 %dead, label %free, label %${traced ? "root" : "done"}`,
        `free:`,
      ];
      teardown(reld);
      reld.push(`  br label %done`);
      if (traced) {
        host.declare(`declare void @scr_cyc_on_release(ptr)`);
        reld.push(
          `root:`,
          `  call void @scr_cyc_on_release(ptr %o) ; possible cycle root; may collect`,
          `  br label %done`,
        );
      }
      reld.push(`done:`, `  ret void`, `}`, ``);
      defs.push(...reld);
    } else {
      const rel: string[] = [
        `define internal void @${mangleClassRelease(cls.name)}(ptr %o) ${FN_ATTRS} { ; release ${cls.name}`,
        `entry:`,
        `  %isnull = icmp eq ptr %o, null`,
        `  br i1 %isnull, label %done, label %check`,
        `check:`,
        `  %rc = load i64, ptr %o`,
        `  %imm = icmp eq i64 %rc, -1`,
        `  br i1 %imm, label %done, label %dec`,
        `dec:`,
        `  %n = sub i64 %rc, 1`,
        `  store i64 %n, ptr %o`,
        `  %dead = icmp eq i64 %n, 0`,
        `  br i1 %dead, label %free, label %${traced ? "root" : "done"}`,
        `free:`,
      ];
      teardown(rel);
      rel.push(`  br label %done`);
      if (traced) {
        host.declare(`declare void @scr_cyc_on_release(ptr)`);
        rel.push(
          `root:`,
          `  call void @scr_cyc_on_release(ptr %o) ; possible cycle root; may collect`,
          `  br label %done`,
        );
      }
      rel.push(`done:`, `  ret void`, `}`, ``);
      defs.push(...rel);
    }

    // new: zeroed allocation, rc = 1, the vtable word on hierarchy
    // members, undefined-admitting union fields at the interned unit
    // instance, alloc note. Traced shapes allocate with the collector
    // header (scr_cyc_alloc zeroes and aborts on OOM itself).
    const nw: string[] = [
      `define internal ptr @${mangleClassNew(cls.name)}() ${FN_ATTRS} { ; new ${cls.name}`,
      `entry:`,
    ];
    if (traced) {
      host.declare(`declare ptr @scr_cyc_alloc(i64, ptr, ptr)`);
      nw.push(
        `  %o = call ptr @scr_cyc_alloc(i64 ${sizeOf}, ptr @${mangleClassTrace(cls.name)}, ptr @${mangleClassGcFree(cls.name)})`,
      );
    } else {
      host.declare(`declare ptr @calloc(i64, i64)`);
      host.needOom();
      nw.push(
        `  %o = call ptr @calloc(i64 1, i64 ${sizeOf})`,
        `  %isnull = icmp eq ptr %o, null`,
        `  br i1 %isnull, label %oom, label %ok`,
        `oom:`,
        `  call void @sc_oom()`,
        `  unreachable`,
        `ok:`,
      );
    }
    nw.push(`  store i64 1, ptr %o`);
    if (meta.hierarchy) {
      nw.push(
        `  %vtp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 1`,
        `  store ptr @${mangleVtInstance(cls.name)}, ptr %vtp`,
      );
    }
    if (isEmitterRooted) {
      // The ScrEmitter prefix: registry stays NULL (zeroed allocation);
      // the display name Node's leak warning prints ([My]) is the source
      // class name, without the module qualifier (emit-shapes.ts's rule).
      const displayName = cls.name.includes(".")
        ? cls.name.slice(cls.name.lastIndexOf(".") + 1)
        : cls.name;
      nw.push(
        `  %clsp = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 3`,
        `  store ptr ${host.cstr(displayName)}, ptr %clsp ; EventEmitter prefix display name`,
      );
    }
    nw.push(...undefFieldInits(host, meta));
    nw.push(`  call void @scr_obj_alloc_note()`, `  ret ptr %o`, `}`, ``);
    defs.push(...nw);

    if (traced) {
      // trace: visit exactly the cycle-capable fields; gcFree: release
      // exactly the complement, then free (the trace/teardown complement
      // contract in scr_runtime.h).
      const indexed = cls.fields.map((f, i) => ({ ...f, index: fieldIndex(i) }));
      const tracedFields = indexed.filter((f) => traceAdapter(host, f.type) !== null);
      const untracedRefFields = indexed.filter(
        (f) => isRefCounted(f.type) && traceAdapter(host, f.type) === null,
      );
      const tr: string[] = [
        `define internal void @${mangleClassTrace(cls.name)}(ptr %o, ptr %visit, ptr %ctx) ${FN_ATTRS} { ; trace ${cls.name}`,
        `entry:`,
      ];
      if (isEmitterRooted) tr.push(...regCall("tr", "scr_emitter_reg_trace", ", ptr %visit, ptr %ctx"));
      if (isStreamRooted) tr.push(...stCall("trs", "scr_stream_st_trace", ", ptr %visit, ptr %ctx"));
      tracedFields.forEach((f, i) => {
        tr.push(
          `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
          `  %v${i} = load ptr, ptr %f${i}`,
          `  call void %visit(ptr %v${i}, ptr %ctx) ; ${f.name}`,
        );
      });
      tr.push(`  ret void`, `}`, ``);
      defs.push(...tr);

      const gf: string[] = [
        `define internal void @${mangleClassGcFree(cls.name)}(ptr %o) ${FN_ATTRS} { ; gcFree ${cls.name}`,
        `entry:`,
      ];
      if (isEmitterRooted) gf.push(...regCall("gf", "scr_emitter_reg_gcfree", ""));
      if (isStreamRooted) gf.push(...stCall("gfs", "scr_stream_st_gcfree", ""));
      untracedRefFields.forEach((f, i) => {
        gf.push(
          `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
          `  %v${i} = load ptr, ptr %f${i}`,
          `  call void ${releaseSym(host, f.type)}(ptr %v${i}) ; ${f.name} (acyclic)`,
        );
      });
      host.declare(`declare void @scr_cyc_free(ptr)`);
      gf.push(`  call void @scr_obj_free_note()`, `  call void @scr_cyc_free(ptr %o)`, `  ret void`, `}`, ``);
      defs.push(...gf);
    }
  }
  return { typeDefs, defs };
}

/** Class objects (classes as first-class values): the immortal ScrClassObj
 * statics plus their construct thunks — allocate, run the constructor over
 * a +1 `this`, hand the remaining +1 out (the C emitCtorThunkDefs, minus
 * the pending check: in-tier constructors are throw-free by construction).
 * `classObjs` maps className → { nameSym } registered during body emission
 * (the literal interned while the table was open). */
export function emitClassObjDefs(
  host: ClassHost,
  metaMap: Map<string, LlClassMeta>,
  classObjs: Map<string, { nameSym: string }>,
  fnByName: Map<string, IrFunction>,
  llType: (t: IrType) => string,
): string[] {
  const out: string[] = [];
  for (const [className, { nameSym }] of classObjs) {
    const meta = metaMap.get(className);
    if (!meta) throw new Error(`llvm emitter bug: class object for unknown class ${className}`);
    // A generic instantiation's class object carries its FAMILY's interval
    // (JS has ONE `Box` at runtime); construction still dispatches the
    // instantiation's own thunk.
    const intervalMeta = meta.def.genericOf !== undefined ? metaMap.get(meta.def.genericOf) : meta;
    if (!intervalMeta) {
      throw new Error(`llvm emitter bug: class object for ${className} names unknown family ${meta.def.genericOf ?? ""}`);
    }
    const ctor = fnByName.get(`%${className}.constructor`);
    if (!ctor) throw new Error(`llvm emitter bug: class object for ${className} without a constructor`);
    const params = ctor.params.slice(1);
    const paramDecls = params.map((p, i) => `${llType(p.type)} %a${i}`).join(", ");
    const ctorArgs = params.map((p, i) => `${llType(p.type)} %a${i}`);
    out.push(
      `define internal ptr @${mangleCtorThunk(className)}(${paramDecls}) ${FN_ATTRS} { ; construct thunk ${className}`,
      `entry:`,
      `  %o = call ptr @${mangleClassNew(className)}()`,
      `  %r = call ptr @${mangleClassRetain(className)}(ptr %o)`,
      `  call void @${mangleFunction(`%${className}.constructor`)}(${[`ptr %r`, ...ctorArgs].join(", ")})`,
      `  ret ptr %o`,
      `}`,
      `@${mangleClassObj(className)} = internal global %ScrClassObj ` +
        `{ i64 -1, i64 ${intervalMeta.pre}, i64 ${intervalMeta.post}, ptr @${mangleCtorThunk(className)}, ptr ${nameSym} } ; class ${className}`,
      ``,
    );
  }
  return out;
}
