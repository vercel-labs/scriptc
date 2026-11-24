/** Names the files a bootstrap seed is built from, for the seed cache.
 *
 * The seed build compiles the compiler from the workspace packages and stages
 * the runtime pack and LLVM helper it links, so the input set is the whole
 * packages tree (minus the per-package test directories no build reads),
 * internal/, the build scripts, the native code generation, the patches
 * applied at install, the manifests and toolchain pins, and the CI steps that
 * invoke the build. Naming the packages whole keeps a directory added later —
 * ambient declarations, shims, a new source tree — inside the identity
 * without anyone remembering to list it: a missed input would hand one tree's
 * seed to another, while an extra one only costs a cache miss. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SEED_INPUT_PATHSPECS = [
  ":(glob)packages/**",
  ":(exclude,glob)packages/*/test/**",
  ":(glob)internal/**",
  ":(glob)scripts/**",
  ":(glob)native/**",
  ":(glob)patches/**",
  ".node-version",
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".github/workflows/ci.yml",
  ":(glob).github/actions/**",
];

/** Every tracked input file of the checkout at `repo`, sorted by path. */
export function seedInputFiles(repo = root) {
  const listing = execFileSync("git", ["ls-files", "-z", "--", ...SEED_INPUT_PATHSPECS], {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
  });
  return listing
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "")
    .sort();
}

/** The seed's identity. It moves when an input file is added, removed, moved
 * or edited, and it names the lane and runner image the seed was built on.
 * Two checkouts that answer the same identity build the same seed. */
export function seedInputs(repo, { flavor, imageOS = "unknown", imageVersion = "unknown" }) {
  for (const [name, value] of Object.entries({ flavor, imageOS, imageVersion })) {
    if (typeof value !== "string" || !/^[\w.-]+$/.test(value)) {
      throw new Error(`bootstrap seed identity needs a well-formed ${name}, not ${value}`);
    }
  }
  const hash = createHash("sha256");
  for (const path of seedInputFiles(repo)) {
    hash.update(path).update("\0");
    hash.update(readFileSync(join(repo, path))).update("\0");
  }
  return `bootstrap-seed-v3-${flavor}-${imageOS}-${imageVersion}-${hash.digest("hex")}`;
}

function main() {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  const identity = seedInputs(root, {
    flavor: process.env.SCRIPTC_BOOTSTRAP_SEED_FLAVOR,
    imageOS: process.env.ImageOS ?? "unknown",
    imageVersion: process.env.ImageVersion ?? "unknown",
  });
  appendFileSync(output, `inputs=${identity}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
