/* Counted lifetime regions (@scriptc/experimental LifetimeRegion): the
 * emitted half of scr_region.c, for programs that construct a region
 * (IrModule.lifetimeRegions).
 *
 * In such a program every ProgramLifetime instance is allocated in the
 * thread's current region: `new` bumps the class's cursor (a pair of
 * pointers the runtime refills), and the class's retain and release, which
 * ProgramLifetime otherwise leaves empty, adjust the count word at the base
 * of the 2 MiB chunk the instance lies in. They count only once the
 * process has created a region, and only in chunks of freeable regions
 * (see countBody), so a program that supports regions but runs without one
 * pays a load and a branch per retain or release.
 *
 * The release walk needs three kinds of emitted code, all here:
 * - per ProgramLifetime class, a visit that reports every reference field
 *   and a fields-release that releases them, in its ScrRgnClass descriptor;
 * - per ordinary class and record whose instances can hold references to
 *   ProgramLifetime instances (directly or through what they own), a walker
 *   that reports its fields; a hierarchy walker dispatches on the dynamic
 *   class like the publication walkers;
 * - the type table that maps each of those types' container release entry
 *   point (shapes.ts vAdapters) to its walker, or marks a ProgramLifetime
 *   class. The runtime walks its own containers, closures and dyn values
 *   through the entry points they store and this table.
 * A field is reported only when its static type can reach a ProgramLifetime
 * instance; not reporting a field leaves its references unexplained, which
 * keeps the region, so the reachability below may over-approximate freely.
 *
 * Programs that never construct a region emit none of this. */
import type { IrClassDef, IrModule, IrType, IrUnionDef } from "../../ir/ir.js";
import { isRefCounted } from "../../ir/ir.js";
import {
  mangleClassRelease,
  mangleClassStruct,
  mangleRecordRelease,
  mangleRecordStruct,
} from "../mangle.js";
import { threadHotAddressLines } from "./alloc.js";
import { classFieldBase, classPreLines, type LlClassMeta } from "./classes.js";
import { llvmCommentText } from "./common.js";
import type { NullableRefFields } from "./nullable-fields.js";
import { FN_ATTRS, rcMembers, releaseSym, vAdapters, type ShapeHost } from "./shapes.js";

/** log2 of SCR_RGN_CHUNK (scr_runtime.h). */
const CHUNK_SHIFT = 21;
/** The type table's symbol (scr_region_create's argument). */
export const REGION_TYPES = "@sc_rgn_types";

export interface RegionHost extends ShapeHost {
  readonly unionsById: ReadonlyMap<string, IrUnionDef>;
  cstr(text: string): string;
}

type Field = { name: string; type: IrType; index: number };

/** Region emission for one module, created only when it uses regions. */
export class LifetimeRegions {
  /** class/record key → whether its instances can reach a ProgramLifetime instance. */
  private readonly reach = new Map<string, boolean>();

  constructor(
    private readonly host: RegionHost,
    private readonly mod: IrModule,
    private readonly metaMap: ReadonlyMap<string, LlClassMeta>,
    private readonly lifetime: (meta: LlClassMeta) => boolean,
    private readonly nullable: NullableRefFields | undefined,
  ) {
    this.computeReach();
  }

  private tag(word: "count" | "owner" | "cursor" | "counting"): string {
    return this.host.regionAliasTag?.(word) ?? "";
  }

  private get chunkMask(): string {
    return String((1 << CHUNK_SHIFT) - 1);
  }

  /** Whether `className` is a ProgramLifetime class. */
  private isLifetime(className: string): boolean {
    const meta = this.metaMap.get(className);
    return meta !== undefined && this.lifetime(meta);
  }

  /** The reference-holding fields; inline scalar unions own nothing. */
  private classFields(def: IrClassDef, meta: LlClassMeta): Field[] {
    const base = classFieldBase(meta);
    return def.fields.flatMap((f, i) =>
      this.host.inlineUnions.classField(def.name, f.name)
        ? []
        : [
            {
              name: f.name,
              type: this.nullable?.storageType(def.name, f.name, f.type) ?? f.type,
              index: base + i,
            },
          ],
    );
  }

  /** Can a value of type `t` hold (or own something that holds) a
   * reference to a ProgramLifetime instance the walk can explain? */
  private reaches(t: IrType): boolean {
    const nullable = this.host.nullableUnions.of(t);
    if (nullable?.repr === "single") return this.reaches(nullable.arm);
    switch (t.kind) {
      case "object":
        return this.isLifetime(t.className) || this.reach.get(`object:${t.className}`) === true;
      case "record":
        return this.reach.get(`record:${t.shapeId}`) === true;
      case "array":
      case "set":
        return this.reaches(t.elem);
      case "map":
        return this.reaches(t.key) || this.reaches(t.value);
      case "union": {
        const def = this.host.unionsById.get(t.unionId);
        return def !== undefined && def.arms.some((a) => this.reaches(a));
      }
      // Closures capture anything, and dyn values box class instances.
      case "func":
      case "dyn":
      case "jsval":
        return true;
      default:
        return false;
    }
  }

  /** The least fixpoint of `reach` over the module's classes and records.
   * A class's own walker reports its (flattened) fields, so it is emitted
   * when one of them reaches (`own:`); a field of a hierarchy type holds
   * any class of its subtree, so the type reaches when any of them does.
   * Runtime-rooted classes keep runtime state the walk does not know, so
   * they are never walked. */
  private computeReach(): void {
    const classes = (this.mod.classes ?? []).filter((c) => !c.runtime);
    for (let changed = true; changed;) {
      changed = false;
      const set = (key: string, value: boolean): void => {
        if (value && this.reach.get(key) !== true) {
          this.reach.set(key, true);
          changed = true;
        }
      };
      for (const shape of this.mod.records ?? [])
        set(
          `record:${shape.id}`,
          rcMembers(shape, this.host.inlineUnions).some((m) => this.reaches(m.type)),
        );
      for (const c of classes) {
        const meta = this.metaMap.get(c.name)!;
        if (this.lifetime(meta) || meta.root.def.runtime === true) continue;
        set(
          `own:${c.name}`,
          this.classFields(c, meta).some((f) => this.reaches(f.type)),
        );
      }
      for (const c of classes) {
        const meta = this.metaMap.get(c.name)!;
        if (this.lifetime(meta) || meta.root.def.runtime === true) continue;
        set(
          `object:${c.name}`,
          this.subtree(meta).some((m) => this.reach.get(`own:${m.def.name}`) === true),
        );
      }
    }
  }

  private subtree(meta: LlClassMeta): LlClassMeta[] {
    if (!meta.hierarchy) return [meta];
    return [...this.metaMap.values()]
      .filter((m) => m.pre >= meta.pre && m.pre <= meta.post && m.def.runtime !== true)
      .sort((a, b) => a.pre - b.pre);
  }

  private cursor(className: string): string {
    return `@${mangleClassStruct(className)}.rcur`;
  }

  private descriptor(className: string): string {
    return `@${mangleClassStruct(className)}.rcls`;
  }

  /** A class's own-fields walker and the walker of its type. */
  private ownWalker(className: string): string {
    return `@${mangleClassStruct(className)}.rown`;
  }

  private classWalker(className: string): string {
    return `@${mangleClassStruct(className)}.rwalk`;
  }

  /** The chunk base of `obj` into `%<p>.cp` (a pointer to its count word). */
  private chunkLines(p: string, obj: string): string[] {
    const S = this.host.sizeType;
    return [
      `  %${p}.i = ptrtoint ptr ${obj} to ${S}`,
      `  %${p}.off = and ${S} %${p}.i, ${this.chunkMask}`,
      `  %${p}.neg = sub ${S} 0, %${p}.off`,
      `  %${p}.cp = getelementptr i8, ptr ${obj}, ${S} %${p}.neg`,
    ];
  }

  private countType(): string {
    return "i64";
  }

  /** `new`'s allocation for a ProgramLifetime class: the zeroed instance in
   * `%o`. Its first reference needs no count: the runtime counts one per
   * object a chunk holds. */
  allocLines(className: string, sizeOf: string): string[] {
    const S = this.host.sizeType;
    const cur = this.cursor(className);
    const tag = this.tag("cursor");
    this.host.declare(`declare ptr @scr_region_alloc(ptr, ptr)`);
    this.host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    return [
      `  %rgn.sz7 = add ${S} ${sizeOf}, 7`,
      `  %rgn.sz = and ${S} %rgn.sz7, -8`,
      `  %rgn.lp = getelementptr inbounds { ptr, ptr }, ptr ${cur}, i32 0, i32 1`,
      `  %rgn.p = load ptr, ptr ${cur}${tag}`,
      `  %rgn.l = load ptr, ptr %rgn.lp${tag}`,
      `  %rgn.np = getelementptr i8, ptr %rgn.p, ${S} %rgn.sz`,
      `  %rgn.fit0 = icmp ule ptr %rgn.np, %rgn.l`,
      `  %rgn.fit = call i1 @llvm.expect.i1(i1 %rgn.fit0, i1 true)`,
      `  br i1 %rgn.fit, label %rgn.fast, label %rgn.slow`,
      `rgn.fast:`,
      `  store ptr %rgn.np, ptr ${cur}${tag}`,
      `  br label %rgn.done`,
      `rgn.slow:`,
      `  %rgn.s = call ptr @scr_region_alloc(ptr ${cur}, ptr ${this.descriptor(className)})`,
      `  br label %rgn.done`,
      `rgn.done:`,
      `  %o = phi ptr [ %rgn.p, %rgn.fast ], [ %rgn.s, %rgn.slow ]`,
    ];
  }

  /** The retain (`add`) or release (`sub`) body of a ProgramLifetime class:
   * the count of the chunk holding the instance. Nothing is counted before
   * the process creates its first region (scr_region_counting), and only
   * chunks of freeable regions have an owner: the default regions' objects
   * are never freed, so their references need no count. Worker executables
   * count only their own chunks; a published instance other threads read
   * is never counted by them. The counting path is marked unlikely: speed
   * builds inline these bodies into every use of an instance, and in
   * programs that never create a region the path is never taken, so it is
   * laid out away from the callers' hot code. */
  countBody(fnName: string, ret: "ptr" | "void", comment: string): string[] {
    const count = this.tag("count");
    const workers = this.host.threadLocalAlloc === true;
    this.host.declare(`@scr_region_counting = external global i8`);
    this.host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
    // Worker threads set and read the flag concurrently: an unordered
    // atomic load, which LLVM may still hoist like a plain one.
    const flag = workers
      ? `load atomic i8, ptr @scr_region_counting unordered, align 1`
      : `load i8, ptr @scr_region_counting`;
    const lines = [
      `define internal ${ret} @${fnName}(ptr %o) ${FN_ATTRS} {${comment ? ` ; ${comment} (region count)` : ""}`,
      `entry:`,
      `  %on = ${flag}${this.tag("counting")}`,
      `  %idle = icmp eq i8 %on, 0`,
      `  %isnull = icmp eq ptr %o, null`,
      `  %skip0 = or i1 %idle, %isnull`,
      `  %skip = call i1 @llvm.expect.i1(i1 %skip0, i1 true)`,
      `  br i1 %skip, label %done, label %chunk`,
      `chunk:`,
      ...this.chunkLines("c", "%o"),
      ...(workers ? threadHotAddressLines(this.host, "%self") : []),
      `  %ownp = getelementptr inbounds i8, ptr %c.cp, i64 8`,
      `  %owner = load ptr, ptr %ownp${this.tag("owner")}`,
      workers ? `  %mine = icmp eq ptr %owner, %self` : `  %mine = icmp ne ptr %owner, null`,
      `  br i1 %mine, label %count, label %done`,
      `count:`,
      `  %n = load ${this.countType()}, ptr %c.cp${count}`,
      `  %n1 = ${ret === "ptr" ? "add" : "sub"} ${this.countType()} %n, 1`,
      `  store ${this.countType()} %n1, ptr %c.cp${count}`,
      `  br label %done`,
      `done:`,
      ret === "ptr" ? `  ret ptr %o` : `  ret void`,
      `}`,
    ];
    return lines;
  }

  /** One field's report to the walk (none when it cannot reach a
   * ProgramLifetime instance). */
  private reportLines(struct: string, f: Field, i: number): string[] {
    if (!isRefCounted(f.type) || !this.reaches(f.type)) return [];
    const nullable = this.host.nullableUnions.of(f.type);
    const arm = nullable?.repr === "single" ? nullable.arm : f.type;
    const load = [
      `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
      `  %v${i} = load ptr, ptr %f${i}`,
    ];
    if (arm.kind === "object" && this.isLifetime(arm.className)) {
      this.host.declare(`declare void @scr_region_ref(ptr, ptr)`);
      return [
        ...load,
        `  call void @scr_region_ref(ptr %w, ptr %v${i}) ; ${llvmCommentText(f.name)}`,
      ];
    }
    this.host.declare(`declare void @scr_region_slot(ptr, ptr, ptr)`);
    return [
      ...load,
      `  call void @scr_region_slot(ptr %w, ptr %v${i}, ptr ${vAdapters(this.host, f.type).release}) ; ${llvmCommentText(f.name)}`,
    ];
  }

  private reportBody(head: string, struct: string, fields: Field[]): string[] {
    const lines = [head, `entry:`];
    fields.forEach((f, i) => lines.push(...this.reportLines(struct, f, i)));
    lines.push(`  ret void`, `}`, ``);
    return lines;
  }

  /** The cursor, descriptor, visit and fields-release of a ProgramLifetime
   * class. */
  classDefs(cls: IrClassDef, sizeOf: string): string[] {
    const meta = this.metaMap.get(cls.name)!;
    const struct = mangleClassStruct(cls.name);
    const fields = this.classFields(cls, meta);
    const visit = `@${struct}.rvisit`;
    const release = `@${struct}.rrelease`;
    const tl = this.host.threadLocalAlloc === true ? "thread_local " : "";
    const rel = [
      `define internal void ${release}(ptr %o) ${FN_ATTRS} { ; region fields release ${llvmCommentText(cls.name)}`,
      `entry:`,
    ];
    fields
      .filter((f) => isRefCounted(f.type))
      .forEach((f, i) =>
        rel.push(
          `  %f${i} = getelementptr inbounds %${struct}, ptr %o, i64 0, i32 ${f.index}`,
          `  %v${i} = load ptr, ptr %f${i}`,
          `  call void ${releaseSym(this.host, f.type)}(ptr %v${i}) ; ${llvmCommentText(f.name)}`,
        ),
      );
    rel.push(`  ret void`, `}`, ``);
    const S = this.host.sizeType;
    // The names of the fields the visit reports, in its order (reportLines).
    const reported = fields.filter((f) => isRefCounted(f.type) && this.reaches(f.type));
    const names = `@${struct}.rfields`;
    return [
      `${this.cursor(cls.name)} = internal ${tl}global { ptr, ptr } zeroinitializer`,
      `${names} = internal constant [${reported.length + 1} x ptr] [ ${[...reported.map((f) => `ptr ${this.host.cstr(f.name)}`), "ptr null"].join(", ")} ]`,
      `${this.descriptor(cls.name)} = internal global { ${S}, ptr, ptr, ptr, i32, ptr } { ${S} ${sizeOf}, ptr ${visit}, ptr ${release}, ptr ${this.host.cstr(cls.name.replace(/^%(m\d+\.)?/, ""))}, i32 -1, ptr ${names} } ; region class ${llvmCommentText(cls.name)}`,
      ...this.reportBody(
        `define internal void ${visit}(ptr %o, ptr %w) ${FN_ATTRS} { ; region visit ${llvmCommentText(cls.name)}`,
        struct,
        fields,
      ),
      ...rel,
    ];
  }

  /** The walkers of the ordinary classes and records that can reach a
   * ProgramLifetime instance, and the type table. */
  moduleDefs(): string[] {
    const out: string[] = [];
    const rows: string[] = [];
    const classes = (this.mod.classes ?? []).filter((c) => c.runtime !== true);
    for (const cls of classes) {
      if (this.reach.get(`own:${cls.name}`) !== true) continue;
      out.push(
        ...this.reportBody(
          `define internal void ${this.ownWalker(cls.name)}(ptr %o, ptr %w) ${FN_ATTRS} { ; region walk ${llvmCommentText(cls.name)}`,
          mangleClassStruct(cls.name),
          this.classFields(cls, this.metaMap.get(cls.name)!),
        ),
      );
    }
    for (const cls of classes) {
      const meta = this.metaMap.get(cls.name)!;
      if (this.lifetime(meta)) {
        rows.push(`{ ptr, ptr } { ptr @${mangleClassRelease(cls.name)}, ptr null }`);
        continue;
      }
      if (this.reach.get(`object:${cls.name}`) !== true) continue;
      let walk = this.ownWalker(cls.name);
      if (meta.hierarchy) {
        // A field of this type holds any class of its subtree.
        const S = this.host.sizeType;
        const members = this.subtree(meta).filter(
          (m) => this.reach.get(`own:${m.def.name}`) === true,
        );
        walk = this.classWalker(cls.name);
        out.push(
          `define internal void ${walk}(ptr %o, ptr %w) ${FN_ATTRS} { ; region walk ${llvmCommentText(cls.name)} and its subclasses`,
          `entry:`,
          ...classPreLines(meta, mangleClassStruct(cls.name), "%o", "%pre", S),
          `  switch ${S} %pre, label %done [ ${members.map((m) => `${S} ${m.pre}, label %c${m.pre}`).join(" ")} ]`,
          ...members.flatMap((m) => [
            `c${m.pre}: ; ${llvmCommentText(m.def.name)}`,
            `  call void ${this.ownWalker(m.def.name)}(ptr %o, ptr %w)`,
            `  br label %done`,
          ]),
          `done:`,
          `  ret void`,
          `}`,
          ``,
        );
      }
      rows.push(`{ ptr, ptr } { ptr @${mangleClassRelease(cls.name)}, ptr ${walk} }`);
    }
    for (const shape of this.mod.records ?? []) {
      if (this.reach.get(`record:${shape.id}`) !== true) continue;
      const walk = `@${mangleRecordStruct(shape.id)}.rwalk`;
      out.push(
        ...this.reportBody(
          `define internal void ${walk}(ptr %o, ptr %w) ${FN_ATTRS} { ; region walk record ${shape.id}`,
          mangleRecordStruct(shape.id),
          rcMembers(shape, this.host.inlineUnions, this.host.nullableUnions.fieldBase(shape.id)),
        ),
      );
      rows.push(`{ ptr, ptr } { ptr @${mangleRecordRelease(shape.id)}, ptr ${walk} }`);
    }
    rows.push(`{ ptr, ptr } zeroinitializer`);
    out.push(
      `${REGION_TYPES} = internal constant [${rows.length} x { ptr, ptr }] [ ${rows.join(", ")} ] ; region type table`,
      ``,
    );
    return out;
  }
}
