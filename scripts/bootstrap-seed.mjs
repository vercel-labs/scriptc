import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadataName = "bootstrap-seed.json";

/** A seed's identity: its instrumentation lane and the directory it was built in, relative to the checkout. The
 * directory is relative rather than absolute so the seed can be restored by another task that puts it in the same
 * place; the FFI manifests and IR inside still name absolute paths, so the two tasks must run at the same path. */
function seedMetadata(directory, sanitize) {
  return {
    schema: 2,
    sanitize,
    directory: relative(root, resolve(directory)).split(sep).join("/"),
  };
}

/** Artifacts are scoped to one instrumentation lane and one relative directory. */
export function verifyBootstrapSeed(directory, sanitize) {
  const expected = seedMetadata(directory, sanitize);
  const metadata = JSON.parse(readFileSync(join(directory, metadataName), "utf8"));
  if (Object.entries(expected).some(([key, value]) => metadata[key] !== value)) {
    throw new Error("bootstrap seed identity does not match this lane or directory");
  }
  for (const path of [
    "distribution/bin/scriptc",
    "distribution/bin/scriptc.json",
    ".scriptc/distribution-seed/cli.ir.json",
    ".scriptc/distribution-seed/cli.ll",
    ".scriptc/distribution-seed/compiler.ffi.json",
  ]) {
    if (!existsSync(join(directory, path))) throw new Error(`bootstrap seed is missing ${path}`);
  }
}

/** The environment a bootstrap seed builds with, over the inherited one. The
 * bootstrap compares the seed's LLVM with the native compiler's own emission,
 * which has no function layout. The layout only orders the functions, so the
 * seed is built without it. */
export function seedBuildEnvironment(sanitize) {
  return {
    SCRIPTC_SAN: sanitize ? "1" : "",
    SCRIPTC_NATIVE_EMIT_IR: "1",
    SCRIPTC_NATIVE_OPTIMIZATION: sanitize ? "dev" : "release",
    SCRIPTC_NATIVE_LAYOUT: "",
  };
}

async function main() {
  const directory = process.env.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY;
  if (!directory) throw new Error("bootstrap seed directory is required");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("shared bootstrap seeds require the Linux x64 CI host");
  }
  const sanitize = process.env.SCRIPTC_SAN === "1";
  mkdirSync(directory, { recursive: true });
  execFileSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--import",
      "tsx",
      join(root, "scripts/build-native-cli.mts"),
      join(directory, "distribution"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...seedBuildEnvironment(sanitize) },
    },
  );
  writeFileSync(
    join(directory, metadataName),
    JSON.stringify(seedMetadata(directory, sanitize)) + "\n",
  );
  verifyBootstrapSeed(directory, sanitize);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
