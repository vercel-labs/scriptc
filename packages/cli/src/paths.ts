import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildTargetPlatform, wasiGuestPath } from "@scriptc/compiler";

export type CliOutputKind = "ir" | "c" | "llvm" | "asm" | "obj" | "exe";

const POSIX_SUFFIXES: Record<CliOutputKind, string> = {
  ir: ".ir.json",
  c: ".c",
  llvm: ".ll",
  asm: ".s",
  obj: ".o",
  exe: "",
};

const WINDOWS_SUFFIXES: Record<CliOutputKind, string> = {
  ...POSIX_SUFFIXES,
  asm: ".asm",
  obj: ".obj",
  exe: ".exe",
};

export function defaultOutputName(
  stem: string,
  kind: CliOutputKind,
  platform?: string,
): string {
  const selectedPlatform = platform ?? (kind === "exe" ? buildTargetPlatform() : process.platform);
  if (kind === "exe" && selectedPlatform === "wasi") return `${stem}.wasm`;
  return `${stem}${(selectedPlatform === "win32" ? WINDOWS_SUFFIXES : POSIX_SUFFIXES)[kind]}`;
}

export interface OutputPaths {
  outDir: string;
  outPath: string;
}

/** One authority for explicit and default primary artifact paths. */
export function selectOutputPaths(
  input: string,
  kind: CliOutputKind,
  explicitOut?: string,
  platform?: string,
): OutputPaths {
  const absoluteInput = resolve(input);
  const outDir = explicitOut === undefined
    ? join(dirname(absoluteInput), ".scriptc")
    : dirname(resolve(explicitOut));
  const stem = basename(absoluteInput).replace(/\.(ts|js|mjs|cjs|c|ll)$/, "");
  return {
    outDir,
    outPath: explicitOut === undefined
      ? join(outDir, defaultOutputName(stem, kind, platform))
      : resolve(explicitOut),
  };
}

/** Default executable filename for the build target. Explicit --out paths
 * stay exact; only scriptc's generated default needs the Windows PE suffix. */
export function defaultExecutableName(stem: string, platform: string = buildTargetPlatform()): string {
  return defaultOutputName(stem, "exe", platform);
}

/** Host paths exposed by `scriptc run` to a WASI Preview 1 module. Guest
 * `/tmp` maps to the host's real platform temp directory instead of assuming
 * the POSIX spelling exists (notably false on Windows). */
export function wasiPreopens(
  cwd: string = process.cwd(),
  hostTmp: string = tmpdir(),
): Record<string, string> {
  return { "/": cwd, "/tmp": hostTmp };
}

/** Environment inherited by a WASI module. Host-absolute directory values
 * must not claim paths outside the guest namespace: `/` is the module's
 * capability root/home/cwd and `/tmp` is its writable temporary directory. */
export function wasiEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  hostTmp: string = tmpdir(),
): Record<string, string> {
  const guest = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  guest["PWD"] = "/";
  guest["HOME"] = "/";
  guest["TMPDIR"] = "/tmp";
  if (guest["USERPROFILE"] !== undefined) guest["USERPROFILE"] = "/";
  if (guest["TMP"] !== undefined) guest["TMP"] = "/tmp";
  if (guest["TEMP"] !== undefined) guest["TEMP"] = "/tmp";

  // These optional shell/package-manager paths retain their meaning only
  // when they fall under a capability the runner actually exposes.
  for (const key of ["OLDPWD", "INIT_CWD"] as const) {
    const value = guest[key];
    if (value === undefined) continue;
    const mapped = wasiGuestPath(value, cwd, hostTmp);
    if (mapped === null) delete guest[key];
    else guest[key] = mapped;
  }

  return guest;
}
