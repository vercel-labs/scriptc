import { execFile } from "node:child_process";
import { access, constants, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/* Executable runtime units ship the bitcode the LLVM helper imports small
 * runtime functions from (available_externally, so program code can inline
 * them while the unit's object stays the only linked definition).
 *
 * Speed units produce both artifacts from one optimized LLVM module: the
 * runtime compiler optimizes the C source to bitcode, and the host helper's
 * `runtime-unit` command promotes translation-unit-local symbols to hidden
 * unit-qualified globals and emits the object and the bitcode. With the
 * target's committed runtime profile, the runtime compiler emits the bitcode
 * unoptimized and the helper also optimizes it with the profile (build.mjs),
 * so one LLVM reads and writes every profile. Release units keep the
 * runtime compiler's own objects; their bitcode is the same compilation with
 * -emit-llvm, which the helper's `prune-import` reduces to the bodies that
 * need none of the unit's local state. Both bitcode forms
 * keep only what a program build can import.
 *
 * Every host helper supports every scriptc target, so packs keep building
 * on their usual hosts. Without a runnable host helper (or with
 * SCRIPTC_RUNTIME_BITCODE=0) units are compiled to objects directly and
 * ship no bitcode; program builds then simply import nothing. */

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
      // emit).
      features: Array.isArray(version.features) ? version.features : [],
    };
  } catch {
    if (explicit !== undefined) throw new Error(`SCRIPTC_LLVM_CODEGEN is not usable: ${helper}`);
    return null;
  }
}

/** Compile one unit through the helper. `compileBitcode(output)` must run
 * the runtime compiler with the unit's exact flags plus -emit-llvm.
 * `helperArgs` asks the helper to optimize the unit itself (`--opt-level`,
 * with `--profile-use` or `--profile-generate`), for bitcode the runtime
 * compiler emitted unoptimized.
 * Returns false, leaving no artifacts behind, when the helper cannot emit
 * this unit; the caller then compiles the object directly without bitcode,
 * so a pack never fails to build because of the import path. Otherwise
 * returns an object, with the helper's `profile` match counts when a profile
 * guided the unit, or the profile names of the unit's `functions` when it
 * was instrumented. */
export async function buildRuntimeUnit({
  helper,
  compileBitcode,
  helperArgs = [],
  object,
  bitcode,
  triple,
  tag,
  sections,
}) {
  const optimized = object.replace(/\.o$/, ".opt.bc");
  // A runtime compiler failure is a real build error and surfaces as one.
  await compileBitcode(optimized);
  try {
    const { stdout } = await run(helper.path, [
      "runtime-unit",
      "--input",
      optimized,
      "--object",
      object,
      "--bitcode",
      bitcode,
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
    const detail = (error.stderr || error.message || String(error)).trim().split("\n")[0];
    process.stderr.write(`runtime-unit: ${tag}: emitting without import bitcode (${detail})\n`);
    await Promise.all([rm(object, { force: true }), rm(bitcode, { force: true })]);
    return false;
  } finally {
    await rm(optimized, { force: true });
  }
}

/** Import bitcode for a unit whose object the runtime compiler emits
 * itself (the release flavor). `compileBitcode(output)` must run the
 * runtime compiler with the unit's exact flags plus -emit-llvm. A helper
 * failure only drops the bitcode; the object is unaffected. */
export async function buildImportBitcode({ helper, compileBitcode, bitcode, tag }) {
  const optimized = bitcode.replace(/\.bc$/, ".opt.bc");
  await compileBitcode(optimized);
  try {
    await run(helper.path, ["prune-import", "--input", optimized, "--output", bitcode]);
    return true;
  } catch (error) {
    const detail = (error.stderr || error.message || String(error)).trim().split("\n")[0];
    process.stderr.write(`prune-import: ${tag}: shipping without import bitcode (${detail})\n`);
    await rm(bitcode, { force: true });
    return false;
  } finally {
    await rm(optimized, { force: true });
  }
}
