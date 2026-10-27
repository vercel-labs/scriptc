/* Runtime CPU dispatch for x86-64 executables (cloneForCpuDispatch): the
 * program's functions get a copy compiled for x86-64-v3, chosen once per
 * call by the CPU level the executable detects at startup. */
import type { TargetCpu } from "../target-cpu.js";

/** The levels a dispatching executable carries a copy of its program's
 * functions for, above the baseline. */
export const CPU_DISPATCH_TIERS: readonly TargetCpu[] = ["x86-64-v3"];

/** The CPU level the executable runs at: 1 (the x86-64 baseline) or 3
 * (x86-64-v3), set by @sc_cpu_level_init before the program runs. */
const LEVEL = "@sc_cpu_level";

/** The attribute groups of the x86-64-v3 copies: #0's and #2's (see
 * emit-module.ts functionAttributes) with the level's `target-cpu`. */
const COPY_GROUPS: ReadonlyMap<string, string> = new Map([
  ["0", "3"],
  ["2", "4"],
]);

export function cpuDispatchAttributes(common: string): string[] {
  return [
    `attributes #3 = {${common} "target-cpu"="x86-64-v3" }`,
    `attributes #4 = { noinline${common} "target-cpu"="x86-64-v3" }`,
  ];
}

/** Bits of CPUID leaf 1's ECX that x86-64-v3 needs: SSE3 (0), SSSE3 (9),
 * FMA (12), CMPXCHG16B (13), SSE4.1 (19), SSE4.2 (20), MOVBE (22), POPCNT
 * (23), XSAVE (26), OSXSAVE (27), AVX (28) and F16C (29). */
const LEAF1_ECX = 0x3cd83201;
/** Leaf 7's EBX: BMI1 (3), AVX2 (5) and BMI2 (8). */
const LEAF7_EBX = 0x128;
/** Leaf 0x80000001's ECX: LAHF/SAHF (0) and LZCNT (5). */
const EXT1_ECX = 0x21;

/** `SCRIPTC_CPU_LEVEL` values and the level each caps the executable at. */
const LEVEL_NAMES: readonly [string, number][] = [
  ["0", 0],
  ["1", 1],
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["baseline", 1],
  ["v1", 1],
  ["v2", 2],
  ["v3", 3],
  ["v4", 4],
  ["x86-64", 1],
  ["x86-64-v2", 2],
  ["x86-64-v3", 3],
  ["x86-64-v4", 4],
];

/** @sc_cpu_level and @sc_cpu_level_init, which main calls first:
 * - CPUID reports every x86-64-v3 feature, and XGETBV that the operating
 *   system saves the SSE and AVX registers, for level 3; otherwise 1;
 * - `SCRIPTC_CPU_LEVEL` (a level from 0 to 4, `baseline` or an `x86-64-vN`
 *   name) caps the level; another value caps it at 0. */
export function cpuLevelDefs(declare: (line: string) => void): string[] {
  declare(`declare ptr @getenv(ptr)`);
  declare(`declare i32 @strcmp(ptr, ptr)`);
  const bytes = (text: string): string => `[${text.length + 1} x i8] c"${text}\\00"`;
  const lines = [
    `${LEVEL} = internal global i32 1`,
    `@sc_cpu_level_env = private unnamed_addr constant ${bytes("SCRIPTC_CPU_LEVEL")}`,
    ...LEVEL_NAMES.map(
      ([name], i) => `@sc_cpu_level_name_${i} = private unnamed_addr constant ${bytes(name)}`,
    ),
    `define internal void @sc_cpu_level_init() #0 {`,
    `entry:`,
    `  %max = call { i32, i32, i32, i32 } asm "cpuid", "={ax},={bx},={cx},={dx},{ax},{cx}"(i32 0, i32 0)`,
    `  %max.leaf = extractvalue { i32, i32, i32, i32 } %max, 0`,
    `  %has.leaf7 = icmp uge i32 %max.leaf, 7`,
    `  br i1 %has.leaf7, label %leaf1, label %detected`,
    `leaf1:`,
    `  %l1 = call { i32, i32, i32, i32 } asm "cpuid", "={ax},={bx},={cx},={dx},{ax},{cx}"(i32 1, i32 0)`,
    `  %l1.ecx = extractvalue { i32, i32, i32, i32 } %l1, 2`,
    `  %l1.bits = and i32 %l1.ecx, ${LEAF1_ECX}`,
    `  %l1.ok = icmp eq i32 %l1.bits, ${LEAF1_ECX}`,
    `  br i1 %l1.ok, label %leaf7, label %detected`,
    `leaf7:`,
    `  %l7 = call { i32, i32, i32, i32 } asm "cpuid", "={ax},={bx},={cx},={dx},{ax},{cx}"(i32 7, i32 0)`,
    `  %l7.ebx = extractvalue { i32, i32, i32, i32 } %l7, 1`,
    `  %l7.bits = and i32 %l7.ebx, ${LEAF7_EBX}`,
    `  %l7.ok = icmp eq i32 %l7.bits, ${LEAF7_EBX}`,
    `  %ext = call { i32, i32, i32, i32 } asm "cpuid", "={ax},={bx},={cx},={dx},{ax},{cx}"(i32 -2147483648, i32 0)`,
    `  %ext.max = extractvalue { i32, i32, i32, i32 } %ext, 0`,
    `  %ext.has = icmp uge i32 %ext.max, -2147483647`,
    `  %l7.ext = and i1 %l7.ok, %ext.has`,
    `  br i1 %l7.ext, label %ext1, label %detected`,
    `ext1:`,
    `  %e1 = call { i32, i32, i32, i32 } asm "cpuid", "={ax},={bx},={cx},={dx},{ax},{cx}"(i32 -2147483647, i32 0)`,
    `  %e1.ecx = extractvalue { i32, i32, i32, i32 } %e1, 2`,
    `  %e1.bits = and i32 %e1.ecx, ${EXT1_ECX}`,
    `  %e1.ok = icmp eq i32 %e1.bits, ${EXT1_ECX}`,
    `  br i1 %e1.ok, label %xcr0, label %detected`,
    // Leaf 1 reported OSXSAVE, so XGETBV is available.
    `xcr0:`,
    `  %xcr = call { i32, i32 } asm "xgetbv", "={ax},={dx},{cx}"(i32 0)`,
    `  %xcr.lo = extractvalue { i32, i32 } %xcr, 0`,
    `  %xcr.bits = and i32 %xcr.lo, 6`,
    `  %xcr.ok = icmp eq i32 %xcr.bits, 6`,
    `  %v3 = select i1 %xcr.ok, i32 3, i32 1`,
    `  br label %detected`,
    `detected:`,
    `  %level = phi i32 [ 1, %entry ], [ 1, %leaf1 ], [ 1, %leaf7 ], [ 1, %ext1 ], [ %v3, %xcr0 ]`,
    `  %env = call ptr @getenv(ptr @sc_cpu_level_env)`,
    `  %has.env = icmp ne ptr %env, null`,
    `  br i1 %has.env, label %cap, label %store`,
    `cap:`,
  ];
  // The matching name's level, or 0 when none matches.
  let cap = "0";
  LEVEL_NAMES.forEach(([, level], i) => {
    lines.push(
      `  %name.${i} = call i32 @strcmp(ptr %env, ptr @sc_cpu_level_name_${i})`,
      `  %is.${i} = icmp eq i32 %name.${i}, 0`,
      `  %cap.${i} = select i1 %is.${i}, i32 ${level}, i32 ${cap}`,
    );
    cap = `%cap.${i}`;
  });
  lines.push(
    `  %capped.below = icmp ult i32 ${cap}, %level`,
    `  %capped = select i1 %capped.below, i32 ${cap}, i32 %level`,
    `  br label %store`,
    `store:`,
    `  %final = phi i32 [ %level, %detected ], [ %capped, %cap ]`,
    `  store i32 %final, ptr ${LEVEL}`,
    `  ret void`,
    `}`,
    ``,
  );
  return lines;
}

/** The call main makes before anything else. */
export const CPU_LEVEL_INIT_CALL = `  call void @sc_cpu_level_init()`;

/** A function definition's header, split around its name and parameters. */
interface Header {
  /** `define` and the linkage, up to the return type. */
  linkage: string;
  /** The return type with its attributes. */
  ret: string;
  name: string;
  /** The parameter list between the parentheses. */
  params: string;
  /** Function attributes before the group (`noinline`, `inlinehint`). */
  attrs: string;
  group: string;
  /** What follows the group: a personality, then `{` and a comment. */
  rest: string;
}

const HEADER_START = /^define ((?:internal |private )?)(.*?)@([\w.$-]+)\(/;
const HEADER_END = /^((?: [a-z_]+)*) #(\d+)( .*)$/;
const RETURN_ATTRIBUTES =
  /\b(?:zeroext|signext|noalias|nonnull|noundef|inreg|dereferenceable(?:_or_null)?\(\d+\)|align \d+)\s+/g;

function parseHeader(line: string): Header | null {
  const start = HEADER_START.exec(line);
  if (start === null) return null;
  const open = start[0].length - 1;
  let depth = 0;
  let close = open;
  for (; close < line.length; close++) {
    const c = line.charAt(close);
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  const end = HEADER_END.exec(line.slice(close + 1));
  if (end === null) return null;
  return {
    linkage: `define ${start[1]!}`,
    ret: start[2]!.trim(),
    name: start[3]!,
    params: line.slice(open + 1, close),
    attrs: end[1]!,
    group: end[2]!,
    rest: end[3]!,
  };
}

/** The parameters split at their top-level commas. */
function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params.charAt(i);
    if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "}" || c === "]" || c === ">") depth--;
    else if (c === "," && depth === 0) {
      out.push(params.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (params.trim() !== "") out.push(params.slice(from).trim());
  return out;
}

/** A definition the pass copies: one in an attribute group it has a copy
 * group for (coroutine bodies, #1, keep their one body), with named
 * parameters, no variable arguments and no debug locations. */
function cloneable(header: Header, text: string): boolean {
  if (!COPY_GROUPS.has(header.group)) return false;
  if (text.includes("!dbg")) return false;
  return splitParams(header.params).every((param) => /%[\w.$-]+$/.test(param));
}

/** The dispatching definition under the function's own name: it tail-calls
 * the x86-64-v3 copy at level 3 or higher and the baseline copy otherwise. */
function dispatcher(header: Header): string {
  const args = splitParams(header.params).join(", ");
  const type = header.ret.replace(RETURN_ATTRIBUTES, "").trim();
  const call = (tier: string, result: string): string[] =>
    type === "void"
      ? [`  musttail call void @${header.name}.${tier}(${args})`, `  ret void`]
      : [
          `  ${result} = musttail call ${header.ret} @${header.name}.${tier}(${args})`,
          `  ret ${type} ${result}`,
        ];
  return [
    `${header.linkage}${header.ret} @${header.name}(${header.params}) #0 {`,
    `entry:`,
    `  %sc.cpu.level = load i32, ptr ${LEVEL}`,
    `  %sc.cpu.v3 = icmp uge i32 %sc.cpu.level, 3`,
    `  br i1 %sc.cpu.v3, label %sc.cpu.v3.call, label %sc.cpu.base.call`,
    `sc.cpu.v3.call:`,
    ...call("v3", "%sc.cpu.v3.result"),
    `sc.cpu.base.call:`,
    ...call("base", "%sc.cpu.base.result"),
    `}`,
  ].join("\n");
}

/** A definition split at its header line and its closing brace. */
interface Definition {
  header: Header;
  /** The lines after the header, through the closing `}`. */
  body: string;
  /** Text after the closing brace, kept as it is. */
  after: string;
}

/** Rewrites the program's function definitions in `parts` for runtime
 * dispatch. A definition is a part, or a `define` chunk of a part, that
 * follows a partition group line (emit-module.ts partitionGroupLines);
 * runtime helpers and the module's entry points stay as they are. Each
 * cloneable function `@f` becomes:
 * - `@f.base`, its body as before;
 * - `@f.v3`, the same body in an x86-64-v3 attribute group;
 * - `@f`, a dispatcher with the same signature, which every reference to
 *   the function as a value and every call from outside the program's
 *   functions still names; a function with no such reference gets none.
 * Direct calls between cloned functions go to the caller's own tier, so the
 * level is tested once on entry into the program's code. */
export function cloneForCpuDispatch(parts: readonly string[]): string[] {
  const program: { index: number; chunks: string[] }[] = [];
  for (let i = 1; i < parts.length; i++)
    if (parts[i - 1]!.startsWith("; scriptc-group") && parts[i]!.startsWith("define "))
      program.push({ index: i, chunks: parts[i]!.split(/\n(?=define )/) });
  const defs = new Map<string, Definition>();
  for (const { chunks } of program)
    for (const chunk of chunks) {
      const newline = chunk.indexOf("\n");
      const header = newline < 0 ? null : parseHeader(chunk.slice(0, newline));
      if (header === null) continue;
      const close = chunk.indexOf("\n}", newline);
      if (close < 0) continue;
      const body = chunk.slice(newline + 1, close + 2);
      if (!cloneable(header, body)) continue;
      defs.set(header.name, { header, body, after: chunk.slice(close + 2) });
    }
  if (defs.size === 0) return [...parts];
  const callee = /@([\w.$-]+)\(/g;
  const retarget = (body: string, tier: string): string =>
    body.replace(callee, (all, name: string) => (defs.has(name) ? `@${name}.${tier}(` : all));
  const named = namedFunctions(parts, program, defs, (body) => retarget(body, "base"));
  const out = [...parts];
  for (const { index, chunks } of program)
    out[index] = chunks
      .map((chunk) => {
        const header = HEADER_START.exec(chunk);
        const def = header === null ? undefined : defs.get(header[3]!);
        if (def === undefined) return chunk;
        const h = def.header;
        const copy = (tier: string, group: string): string =>
          `define internal ${h.ret} @${h.name}.${tier}(${h.params})${h.attrs} #${group}${h.rest}\n${retarget(def.body, tier)}`;
        return (
          [
            copy("base", h.group),
            copy("v3", COPY_GROUPS.get(h.group)!),
            ...(named.has(h.name) ? [dispatcher(h)] : []),
          ].join("\n") + def.after
        );
      })
      .join("\n");
  return out;
}

/** The cloned functions whose own name the module still uses once the
 * copies call each other: as a value, or in a call from code that is not
 * copied (main, runtime helpers, coroutine bodies). Only these get a
 * dispatcher. A function without one keeps the callers it had, so LLVM
 * inlines and removes its copies as it would the original. */
function namedFunctions(
  parts: readonly string[],
  program: readonly { index: number; chunks: string[] }[],
  defs: ReadonlyMap<string, Definition>,
  retargeted: (body: string) => string,
): Set<string> {
  const named = new Set<string>();
  const scan = (text: string): void => {
    for (const m of text.matchAll(/@([\w.$-]+)/g)) if (defs.has(m[1]!)) named.add(m[1]!);
  };
  const inProgram = new Set(program.map(({ index }) => index));
  parts.forEach((part, i) => {
    if (!inProgram.has(i)) scan(part);
  });
  for (const { chunks } of program)
    for (const chunk of chunks) {
      const header = HEADER_START.exec(chunk);
      const def = header === null ? undefined : defs.get(header[3]!);
      if (def === undefined) scan(chunk);
      else scan(retargeted(def.body) + def.after);
    }
  return named;
}
