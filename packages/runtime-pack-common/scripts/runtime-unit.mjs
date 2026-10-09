import { execFile } from "node:child_process";
import { access, constants, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/* Release executable runtime units ship two artifacts produced from one
 * optimized LLVM module: the native object and the bitcode the LLVM helper
 * imports small runtime functions from (available_externally, so program
 * code can inline them while the object stays the only linked definition).
 *
 * The runtime compiler optimizes the C source to bitcode; the host LLVM
 * helper's `runtime-unit` command then promotes translation-unit-local
 * symbols to hidden unit-qualified globals and emits both artifacts. Every
 * host helper supports every scriptc target, so packs keep building on
 * their usual hosts. Without a runnable host helper (or with
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
    return { path: helper, identity: `scriptc-llvm-codegen ${version.llvm_version}` };
  } catch {
    if (explicit !== undefined) throw new Error(`SCRIPTC_LLVM_CODEGEN is not usable: ${helper}`);
    return null;
  }
}

/** Compile one unit through the helper. `compileBitcode(output)` must run
 * the runtime compiler with the unit's exact flags plus -emit-llvm.
 * Returns false, leaving no artifacts behind, when the helper cannot emit
 * this unit; the caller then compiles the object directly without bitcode,
 * so a pack never fails to build because of the import path. */
export async function buildRuntimeUnit({
  helper,
  compileBitcode,
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
    await run(helper.path, [
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
    ]);
    return true;
  } catch (error) {
    const detail = (error.stderr || error.message || String(error)).trim().split("\n")[0];
    process.stderr.write(`runtime-unit: ${tag}: emitting without import bitcode (${detail})\n`);
    await Promise.all([rm(object, { force: true }), rm(bitcode, { force: true })]);
    return false;
  } finally {
    await rm(optimized, { force: true });
  }
}
