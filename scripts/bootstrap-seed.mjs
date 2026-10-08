import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadataName = "bootstrap-seed.json";

/** Artifacts are scoped to one workflow revision and instrumentation lane.
 * The directory must stay fixed: FFI manifests and IR include absolute paths. */
export function verifyBootstrapSeed(directory, revision, sanitize) {
  const expected = { schema: 1, revision, sanitize, directory: resolve(directory) };
  const metadata = JSON.parse(readFileSync(join(directory, metadataName), "utf8"));
  if (!revision || Object.entries(expected).some(([key, value]) => metadata[key] !== value)) {
    throw new Error("bootstrap seed identity does not match this checkout, lane, or directory");
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

async function main() {
  const directory = process.env.SCRIPTC_BOOTSTRAP_SEED_DIRECTORY;
  const revision = process.env.GITHUB_SHA;
  if (!directory || !revision)
    throw new Error("bootstrap seed directory and revision are required");
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
      env: {
        ...process.env,
        SCRIPTC_NATIVE_EMIT_IR: "1",
        SCRIPTC_NATIVE_OPTIMIZATION: sanitize ? "dev" : "release",
      },
    },
  );
  writeFileSync(
    join(directory, metadataName),
    JSON.stringify({
      schema: 1,
      revision,
      sanitize,
      directory: resolve(directory),
    }) + "\n",
  );
  verifyBootstrapSeed(directory, revision, sanitize);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
