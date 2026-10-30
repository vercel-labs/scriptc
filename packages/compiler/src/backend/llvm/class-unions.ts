/* Class-union helpers (nullable-unions.ts ClassUnion). A class union's value
 * is the instance pointer; its arm is the arm whose preorder interval holds
 * the instance's class id, which every arm's hierarchy keeps in its header
 * (classes.ts LlClassMeta.idInRc). Each union gets a tag helper, and the
 * unions over the same classes share one retain, release and trace. */
import { InternalCompilerError } from "../../errors.js";
import type { IrModule } from "../../ir/ir.js";
import { mangleClassRelease, mangleClassTrace } from "../mangle.js";
import {
  classIdLoadLines,
  programLifetimeClass,
  type ClassHost,
  type LlClassMeta,
} from "./classes.js";
import {
  NULLABLE_NULL,
  classReleaseFn,
  classRetainFn,
  classTagFn,
  classTraceFn,
  type ClassUnion,
} from "./nullable-unions.js";
import { FN_ATTRS, cycleRootLines, retainBody } from "./shapes.js";

/** The widest span of class ids a union's arms may cover for its helpers
 * to switch on the id; wider unions test each arm's interval. */
const CLASS_TAG_SWITCH_SPAN = 32;

/** One arm's class ids: its class's preorder interval plus 1. */
interface ArmIds {
  tag: number;
  className: string;
  lo: number;
  hi: number;
}

function armIds(
  union: ClassUnion,
  classMeta: ReadonlyMap<string, LlClassMeta>,
): { arms: ArmIds[]; first: LlClassMeta } {
  const arms = union.arms.map((arm) => {
    const meta = classMeta.get(arm.className);
    if (meta === undefined || !meta.idInRc)
      throw new InternalCompilerError(
        `llvm emitter bug: class-union arm ${arm.className} keeps no class id`,
      );
    return { tag: arm.tag, className: arm.className, lo: meta.pre + 1, hi: meta.post + 1 };
  });
  return { arms, first: classMeta.get(union.arms[0]!.className)! };
}

/** Lines that branch from the open block on the class id of the instance
 * `%o`: to `%a<tag>` for the arm holding it and to `missing` for none. */
function armBranchLines(arms: readonly ArmIds[], first: LlClassMeta, missing: string): string[] {
  const lines = classIdLoadLines(first, "%o", "%id", "");
  const span = Math.max(...arms.map((arm) => arm.hi)) - Math.min(...arms.map((arm) => arm.lo)) + 1;
  if (span <= CLASS_TAG_SWITCH_SPAN) {
    const cases: string[] = [];
    for (const arm of arms)
      for (let id = arm.lo; id <= arm.hi; id++) cases.push(`i32 ${id}, label %a${arm.tag}`);
    lines.push(`  switch i32 %id, label %${missing} [ ${cases.join(" ")} ]`);
    return lines;
  }
  arms.forEach((arm, i) => {
    const next = i + 1 < arms.length ? `n${arm.tag}` : missing;
    lines.push(
      `  %r${arm.tag} = sub i32 %id, ${arm.lo}`,
      `  %in${arm.tag} = icmp ult i32 %r${arm.tag}, ${arm.hi - arm.lo + 1}`,
      `  br i1 %in${arm.tag}, label %a${arm.tag}, label %${next}`,
    );
    if (next !== missing) lines.push(`${next}:`);
  });
  return lines;
}

/** Lines that leave for `unit` on NULL and for `nullArm` on the null
 * sentinel, and continue in a new block for an instance. */
function unitLines(union: ClassUnion, unit: string, nullArm: string): string[] {
  const lines = [
    `  %isnull = icmp eq ptr %o, null`,
    `  br i1 %isnull, label %${unit}, label %ref`,
    `ref:`,
  ];
  if (union.nullTag >= 0)
    lines.push(
      `  %isnullarm = icmp eq ptr %o, ${NULLABLE_NULL}`,
      `  br i1 %isnullarm, label %${nullArm}, label %obj`,
      `obj:`,
    );
  return lines;
}

/** A dispatch on the arm of `%o` that runs `call(className)` and returns. */
function armDispatchLines(
  arms: readonly ArmIds[],
  first: LlClassMeta,
  call: (className: string) => string,
): string[] {
  return [
    ...armBranchLines(arms, first, "done"),
    ...arms.flatMap((arm) => [`a${arm.tag}:`, call(arm.className), `  br label %done`]),
    `done:`,
  ];
}

/** A class union's value is whichever instance it holds, and the collector
 * visits it as that instance: when one arm carries a collector header,
 * every arm must. Every class of a hierarchy shares its header decision, so
 * a header reaches each arm's whole hierarchy, and unions that share a
 * hierarchy pass headers on to each other: this repeats until no union
 * adds one. ProgramLifetime classes carry none. */
export function classUnionHeaders(
  mod: IrModule,
  unions: readonly ClassUnion[],
  tracedShapes: Set<string>,
  tracedUnions: ReadonlySet<string>,
): void {
  if (unions.length === 0) return;
  const bases = new Map<string, string | undefined>();
  for (const cls of mod.classes ?? []) bases.set(cls.name, cls.base);
  const rootOf = (name: string): string => {
    let root = name;
    for (let base = bases.get(root); base !== undefined; base = bases.get(root)) root = base;
    return root;
  };
  const members = new Map<string, string[]>();
  for (const cls of mod.classes ?? []) {
    const root = rootOf(cls.name);
    const list = members.get(root);
    if (list) list.push(cls.name);
    else members.set(root, [cls.name]);
  }
  const lifetime = new Set(mod.contracts?.programLifetime ?? []);
  for (let changed = true; changed;) {
    changed = false;
    for (const union of unions) {
      if (lifetime.has(rootOf(union.arms[0]!.className))) continue;
      const names = union.arms.flatMap((arm) => members.get(rootOf(arm.className)) ?? []);
      if (
        !tracedUnions.has(union.unionId) &&
        !names.some((name) => tracedShapes.has(`object:${name}`))
      )
        continue;
      for (const name of names) {
        const key = `object:${name}`;
        if (tracedShapes.has(key)) continue;
        tracedShapes.add(key);
        changed = true;
      }
    }
  }
}

/** The tag helper of every class union, and the retain, release and trace
 * of each one that owns them (NullableUnions.helperOwner).
 * - Retain and release of unions over ProgramLifetime classes do nothing:
 *   those instances count nothing.
 * - Otherwise every arm counts in the low half of its rc word (idInRc), so
 *   retain is the shared increment and release the shared decrement; only
 *   a release of the last reference dispatches on the arm, to the arm's
 *   own release (which tears the dynamic class down).
 * - Trace dispatches on the arm. Every arm carries a collector header when
 *   one does (the emitter's traced fixpoint). */
export function emitClassUnionHelpers(
  host: ClassHost,
  classMeta: ReadonlyMap<string, LlClassMeta>,
): string[] {
  const out: string[] = [];
  for (const union of host.nullableUnions.allClassUnions()) {
    const { arms, first } = armIds(union, classMeta);
    out.push(
      `define internal i32 ${classTagFn(union.unionId)}(ptr %o) alwaysinline ${FN_ATTRS} { ; class union tag`,
      `entry:`,
      ...unitLines(union, "unit", "nullarm"),
      ...armBranchLines(arms, first, "bad"),
      ...arms.flatMap((arm) => [`a${arm.tag}:`, `  ret i32 ${arm.tag}`]),
      `unit:`,
      `  ret i32 ${union.unitTag}`,
      ...(union.nullTag >= 0 ? [`nullarm:`, `  ret i32 ${union.nullTag}`] : []),
      `bad:`,
      `  ret i32 -1`,
      `}`,
      ``,
    );
    if (host.nullableUnions.helperOwner(union.unionId) !== union.unionId) continue;
    const retain = classRetainFn(union.unionId).slice(1);
    const release = classReleaseFn(union.unionId);
    if (programLifetimeClass(host, first)) {
      out.push(
        `define internal ptr @${retain}(ptr %o) ${FN_ATTRS} { ; class union retain (immortal)`,
        `entry:`,
        `  ret ptr %o`,
        `}`,
        ``,
        `define internal void ${release}(ptr %o) ${FN_ATTRS} { ; class union release (immortal)`,
        `entry:`,
        `  ret void`,
        `}`,
        ``,
      );
      continue;
    }
    const traced = host.tracedShapes.has(`object:${first.def.name}`);
    out.push(
      ...retainBody(host, retain, "class union retain", false, "i32"),
      ``,
      `define internal void ${release}(ptr %o) ${FN_ATTRS} { ; class union release (fast path)`,
      `entry:`,
      ...unitLines(union, "done", "done"),
      `  %rc = load i32, ptr %o`,
      `  %rcm2 = sub i32 %rc, 2`,
      `  %shared = icmp ult i32 %rcm2, -3`,
      `  br i1 %shared, label %dec, label %slow`,
      `dec:`,
      `  %n = sub i32 %rc, 1`,
      `  store i32 %n, ptr %o`,
      ...(traced ? cycleRootLines(host, "done") : [`  br label %done`]),
      `slow:`,
      `  %imm = icmp eq i32 %rc, -1`,
      `  br i1 %imm, label %done, label %last`,
      `last:`,
      `  call void ${release}.last(ptr %o)`,
      `  br label %done`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
      `define internal void ${release}.last(ptr %o) noinline ${FN_ATTRS} { ; class union release (last reference)`,
      `entry:`,
      ...armDispatchLines(
        arms,
        first,
        (name) => `  call void @${mangleClassRelease(name)}(ptr %o)`,
      ),
      `  ret void`,
      `}`,
      ``,
    );
    if (traced)
      out.push(
        `define internal void ${classTraceFn(union.unionId)}(ptr %o, ptr %visit, ptr %ctx) ${FN_ATTRS} { ; class union trace`,
        `entry:`,
        ...unitLines(union, "done", "done"),
        ...armDispatchLines(
          arms,
          first,
          (name) => `  call void @${mangleClassTrace(name)}(ptr %o, ptr %visit, ptr %ctx)`,
        ),
        `  ret void`,
        `}`,
        ``,
      );
  }
  return out;
}
