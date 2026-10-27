import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The x86-64 microarchitecture levels an executable may require
 * (`--target-cpu`). `baseline` is the x86-64 baseline every release build
 * targets; the other levels are LLVM's `x86-64-v2` to `x86-64-v4`. */
export type TargetCpu = "baseline" | "x86-64-v2" | "x86-64-v3" | "x86-64-v4";

/** The values `--target-cpu` accepts: a level, or `native` for the highest
 * level the build host supports. */
export const TARGET_CPU_OPTIONS = ["baseline", "x86-64-v2", "x86-64-v3", "x86-64-v4", "native"];

export function isTargetCpuOption(value: unknown): value is TargetCpu | "native" {
  return typeof value === "string" && TARGET_CPU_OPTIONS.includes(value);
}

/** The CPU features each level adds to the one below it, as Linux names
 * them in /proc/cpuinfo (`pni` is SSE3, `abm` includes LZCNT). */
const LEVEL_FLAGS: readonly [TargetCpu, readonly string[]][] = [
  ["x86-64-v2", ["cx16", "lahf_lm", "popcnt", "pni", "sse4_1", "sse4_2", "ssse3"]],
  ["x86-64-v3", ["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"]],
  ["x86-64-v4", ["avx512f", "avx512bw", "avx512cd", "avx512dq", "avx512vl"]],
];

/** The macOS `machdep.cpu` spellings of the same features. */
const DARWIN_FLAGS: Readonly<Record<string, string>> = {
  cx16: "CX16",
  lahf_lm: "LAHF",
  popcnt: "POPCNT",
  pni: "SSE3",
  sse4_1: "SSE4.1",
  sse4_2: "SSE4.2",
  ssse3: "SSSE3",
  avx: "AVX1.0",
  avx2: "AVX2",
  bmi1: "BMI1",
  bmi2: "BMI2",
  f16c: "F16C",
  fma: "FMA",
  abm: "LZCNT",
  movbe: "MOVBE",
  xsave: "XSAVE",
  avx512f: "AVX512F",
  avx512bw: "AVX512BW",
  avx512cd: "AVX512CD",
  avx512dq: "AVX512DQ",
  avx512vl: "AVX512VL",
};

/** The highest level whose features (and every lower level's) are all in
 * `has`. */
export function x86Level(has: (flag: string) => boolean): TargetCpu {
  let level: TargetCpu = "baseline";
  for (const [next, flags] of LEVEL_FLAGS) {
    if (!flags.every(has)) break;
    level = next;
  }
  return level;
}

/** The highest level the build host supports, or null when the host is not
 * an x86-64 Linux or macOS machine. */
export function hostTargetCpu(
  platform: string = process.platform,
  arch: string = process.arch,
): TargetCpu | null {
  if (arch !== "x64") return null;
  try {
    if (platform === "linux") {
      const info = readFileSync("/proc/cpuinfo", "utf8");
      const line = /^flags\s*:(.*)$/m.exec(info);
      if (!line) return null;
      const flags = new Set(line[1]!.trim().split(/\s+/));
      return x86Level((flag) => flags.has(flag));
    }
    if (platform === "darwin") {
      const text = execFileSync(
        "sysctl",
        ["-n", "machdep.cpu.features", "machdep.cpu.leaf7_features", "machdep.cpu.extfeatures"],
        { encoding: "utf8" },
      );
      const flags = new Set(text.trim().split(/\s+/));
      return x86Level((flag) => flags.has(DARWIN_FLAGS[flag]!));
    }
  } catch {
    return null;
  }
  return null;
}

/** Cache-key parts for a target level; empty for the baseline so existing
 * keys are unchanged. */
export function targetCpuKeyParts(cpu: TargetCpu | undefined): string[] {
  return cpu === undefined || cpu === "baseline" ? [] : [`target-cpu-${cpu}`];
}

/** The function attribute that makes LLVM generate code for the level, or
 * "" for the baseline. */
export function targetCpuAttribute(cpu: TargetCpu | undefined): string {
  return cpu === undefined || cpu === "baseline" ? "" : ` "target-cpu"="${cpu}"`;
}

/** The options field for a level: omitted for the baseline. */
export function targetCpuField(cpu: TargetCpu | undefined): { targetCpu?: TargetCpu } {
  return cpu === undefined || cpu === "baseline" ? {} : { targetCpu: cpu };
}

/** Cache-key parts for a dispatching build: the tiers it carries. */
export function cpuDispatchKeyParts(cpuDispatch: boolean | undefined): string[] {
  return cpuDispatch === true ? ["cpu-dispatch-x86-64-v3"] : [];
}

/** The error for a level on a target that is not x86-64, or null. */
export function targetCpuTargetRefusal(
  cpu: TargetCpu | undefined,
  platform: string,
  architecture: string,
): string | null {
  if (cpu === undefined || cpu === "baseline") return null;
  if (architecture !== "x64" || platform === "wasi")
    return `--target-cpu=${cpu} requires an x86-64 target`;
  return null;
}
