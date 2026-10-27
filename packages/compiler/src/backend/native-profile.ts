/** Profile-guided optimization for helper-compiled executables.
 *
 * An instrumented build (`--profile-generate`) counts how often each branch
 * and call runs and writes the counts when the program exits. `scriptc
 * merge-profiles` turns those raw profiles into one indexed profile, and an
 * optimized build (`--profile-use`) lays out, inlines, and splits code by it.
 * The helper applies both in the pre-link pipeline of every partition.
 */
import type { NativeOptimization } from "./optimization.js";

export interface NativeProfileOptions {
  /** Raw profile path pattern written by the instrumented executable. */
  generate?: string;
  /** Indexed profile and the digest of its bytes, which key every cache. */
  use?: { path: string; digest: string };
}

/** Why a request cannot use profiles, or null when it can. */
export function nativeProfileRefusal(options: {
  profileGenerate?: string;
  profileUse?: string;
  outputKind: string;
  optimization: NativeOptimization;
  sanitize: boolean;
  platform: string;
}): string | null {
  const generate = options.profileGenerate !== undefined;
  const use = options.profileUse !== undefined;
  if (!generate && !use) return null;
  const flag = generate ? "--profile-generate" : "--profile-use";
  if (generate && use) return "--profile-generate and --profile-use cannot be combined";
  if (options.outputKind !== "exe") return `${flag} is only supported for executable output`;
  if (options.sanitize) return `${flag} cannot be combined with --sanitize`;
  if (options.optimization === "dev")
    return `${flag} needs an optimized build (--optimization=release or speed)`;
  if (generate && options.platform !== "linux")
    return "--profile-generate is only supported for Linux executables";
  return null;
}

export function nativeProfileHelperArgs(profile: NativeProfileOptions | undefined): string[] {
  if (profile?.generate !== undefined) return ["--profile-generate", profile.generate];
  if (profile?.use !== undefined) return ["--profile-use", profile.use.path];
  return [];
}

/** How an optimized build's profile matched the program's functions, as the
 * helper reports it: functions that took the profile's counts, functions
 * whose control flow changed since the profile was collected, functions the
 * profile has no record of (new, or never run while it was collected), and
 * partitions reused from the cache without their counts. */
export interface NativeProfileMatch {
  annotated: number;
  mismatched: number;
  missing: number;
  unknownPartitions: number;
}

/** The profile match in a successful helper emit's output, or null when the
 * helper reports none (a helper that predates the report). */
export function parseNativeProfileMatch(stdout: string): NativeProfileMatch | null {
  for (const line of stdout.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const profile = (parsed as { profile?: Record<string, unknown> } | null)?.profile;
    if (typeof profile !== "object" || profile === null) continue;
    const count = (key: string): number | null => {
      const value = profile[key];
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
    };
    const annotated = count("annotated");
    const mismatched = count("mismatched");
    const missing = count("missing");
    const unknownPartitions = count("unknown_partitions");
    if (annotated === null || mismatched === null || missing === null || unknownPartitions === null)
      continue;
    return { annotated, mismatched, missing, unknownPartitions };
  }
  return null;
}

/** The share of the functions a profile describes whose control flow changed
 * since it was collected, above which `scriptc build` warns that the profile
 * is stale. A freshly collected profile has none. */
export const STALE_PROFILE_SHARE = 0.1;

/** `scriptc build --profile-use`'s report on stderr: one line with the match,
 * and a warning line when more than STALE_PROFILE_SHARE of the functions the
 * profile describes changed since it was collected. */
export function renderNativeProfileMatch(profile: string, match: NativeProfileMatch): string {
  const unknown =
    match.unknownPartitions === 0
      ? ""
      : `, ${match.unknownPartitions} partition${match.unknownPartitions === 1 ? "" : "s"} without counts`;
  const lines = [
    `scriptc: profile ${profile}: ${match.annotated} functions annotated, ${match.mismatched} mismatched, ${match.missing} without a record${unknown}`,
  ];
  const described = match.annotated + match.mismatched;
  if (described > 0 && match.mismatched / described > STALE_PROFILE_SHARE) {
    const percent = ((match.mismatched / described) * 100).toFixed(1);
    lines.push(
      `scriptc: warning: ${match.mismatched} of the ${described} functions ${profile} describes (${percent}%) changed since it was collected and are optimized without their counts; collect the profile again`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Cache-key part; empty without a profile so other keys are unchanged. */
export function nativeProfileKey(profile: NativeProfileOptions | undefined): string {
  if (profile?.generate !== undefined) return `profile-generate:${profile.generate}`;
  if (profile?.use !== undefined) return `profile-use:${profile.use.digest}`;
  return "";
}

/** The instrumented link adds the compiler driver's profile runtime. */
export function profileGenerateLinkerArgs(generate: boolean): string[] {
  return generate ? ["-fprofile-generate"] : [];
}
