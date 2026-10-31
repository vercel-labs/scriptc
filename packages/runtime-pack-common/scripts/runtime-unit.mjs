import { execFile } from "node:child_process";
import { access, constants, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/* Speed units are emitted through the host LLVM helper: the runtime
 * compiler compiles the C source to bitcode, and the helper's `runtime-unit`
 * command promotes translation-unit-local symbols to hidden unit-qualified
 * globals and emits the object. With the target's committed runtime profile,
 * the runtime compiler emits the bitcode unoptimized and the helper also
 * optimizes it with the profile (build.mjs), so one LLVM reads and writes
 * every profile. Runtime packs ship objects only: program builds do not
 * import runtime bitcode.
 *
 * Every host helper supports every scriptc target, so packs keep building
 * on their usual hosts. Without a runnable host helper (or with
 * SCRIPTC_RUNTIME_BITCODE=0) a pack has no speed flavor. */

function hostHelperPackage() {
  if (process.platform === "darwin") return `llvm-darwin-${process.arch}`;
  if (process.platform === "win32") return `llvm-win32-${process.arch}-msvc`;
  if (process.platform === "linux") {
    const musl = process.report?.getReport?.().header?.glibcVersionRuntime === undefined;
    return `llvm-linux-${process.arch}-${musl ? "musl" : "gnu"}`;
  }
  return null;
}

export async function resolveRuntimeUnitHelper(repoRoot, triple) {
  if (process.env.SCRIPTC_RUNTIME_BITCODE === "0") return null;
  const explicit = process.env.SCRIPTC_LLVM_CODEGEN;
  const pkg = hostHelperPackage();
  const helper =
    explicit ??
    (pkg === null
      ? null
      : join(
          repoRoot,
          "packages",
          pkg,
          "bin",
          process.platform === "win32" ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen",
        ));
  if (helper === null) return null;
  try {
    await access(helper, constants.X_OK);
    const { stdout } = await run(helper, ["version", "--format=json"]);
    const version = JSON.parse(stdout);
    if (!version.supported_targets?.includes(triple)) return null;
    return {
      path: helper,
      identity: `scriptc-llvm-codegen ${version.llvm_version}`,
      // Commands and options newer than the protocol version, such as
      // "runtime-unit-profile": `runtime-unit` takes --opt-level,
      // --profile-use and --profile-generate (older helpers only promote and
      // emit); "runtime-unit-optional-bitcode": it emits the object without
      // the import bitcode.
      features: Array.isArray(version.features) ? version.features : [],
    };
  } catch {
    if (explicit !== undefined) throw new Error(`SCRIPTC_LLVM_CODEGEN is not usable: ${helper}`);
    return null;
  }
}

/** The helper's diagnostic from a failed command: its JSON line, which
 * follows any LLVM warnings on the same streams. */
function helperFailure(error) {
  const lines = [error.stdout, error.stderr]
    .filter((text) => typeof text === "string")
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.find((line) => line.startsWith("{")) ??
    lines.find((line) => !line.includes("is not a recognized feature")) ??
    lines[0] ??
    error.message ??
    String(error)
  );
}

/** Compile one unit through the helper. `compileBitcode(output)` must run
 * the runtime compiler with the unit's exact flags plus -emit-llvm.
 * `helperArgs` asks the helper to optimize the unit itself (`--opt-level`,
 * with `--profile-use` or `--profile-generate`), for bitcode the runtime
 * compiler emitted unoptimized.
 * Returns false, leaving no artifacts behind, when the helper cannot emit
 * this unit; the caller then compiles the object directly. Otherwise
 * returns an object, with the helper's `profile` match counts when a profile
 * guided the unit, or the profile names of the unit's `functions` when it
 * was instrumented. */
export async function buildRuntimeUnit({
  helper,
  compileBitcode,
  helperArgs = [],
  object,
  triple,
  tag,
  sections,
}) {
  const optimized = object.replace(/\.o$/, ".opt.bc");
  // Helpers older than "runtime-unit-optional-bitcode" always write it.
  const bitcode = helper.features.includes("runtime-unit-optional-bitcode")
    ? null
    : object.replace(/\.o$/, ".import.bc");
  // A runtime compiler failure is a real build error and surfaces as one.
  await compileBitcode(optimized);
  try {
    const { stdout } = await run(helper.path, [
      "runtime-unit",
      "--input",
      optimized,
      "--object",
      object,
      ...(bitcode === null ? [] : ["--bitcode", bitcode]),
      "--target",
      triple,
      "--tag",
      tag,
      ...(sections ? ["--function-sections", "--data-sections"] : []),
      ...helperArgs,
    ]);
    const report = stdout.trim() === "" ? {} : JSON.parse(stdout.trim().split("\n").pop());
    return {
      ...(report.profile === undefined ? {} : { profile: report.profile }),
      ...(report.functions === undefined ? {} : { functions: report.functions }),
    };
  } catch (error) {
    process.stderr.write(
      `runtime-unit: ${tag}: compiling the object directly (${helperFailure(error)})\n`,
    );
    await rm(object, { force: true });
    return false;
  } finally {
    await rm(optimized, { force: true });
    if (bitcode !== null) await rm(bitcode, { force: true });
  }
}
