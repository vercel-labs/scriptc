import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDeterministicArchive } from "./archive.mjs";

// Each parameter set has its own symbols. The 768 object also supplies the
// code shared by all three sets.
export async function buildMlkemArchive({
  source,
  stagedOutputRoot,
  compile,
  parallel,
  archiver,
  archiverArgs,
  flags,
}) {
  const root = join(stagedOutputRoot, "vendor", "mlkem");
  const objects = join(root, "objects");
  const levels = [512, 768, 1024];
  await parallel(levels, (level) =>
    compile(join(source, "mlkem_native.c"), join(objects, `mlkem${level}.o`), [
      ...flags,
      "-std=c11",
      "-O2",
      "-I",
      source,
      "-I",
      join(source, "src"),
      `-DMLK_CONFIG_PARAMETER_SET=${level}`,
      "-DMLK_CONFIG_MULTILEVEL_BUILD",
      level === 768 ? "-DMLK_CONFIG_MULTILEVEL_WITH_SHARED" : "-DMLK_CONFIG_MULTILEVEL_NO_SHARED",
    ]),
  );
  const output = join(root, "libscriptc-mlkem.a");
  await createDeterministicArchive(
    archiver,
    output,
    levels.map((n) => join(objects, `mlkem${n}.o`)),
    archiverArgs,
  );
  await rm(objects, { recursive: true, force: true });
  const bytes = await readFile(output);
  return {
    id: "mlkem",
    path: "artifacts/vendor/mlkem/libscriptc-mlkem.a",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
