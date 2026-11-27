import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

/** `// @tsc-legacy-decorators` (and `// @tsc-decorator-metadata`) in the
 * entry file's directive head: the Node side runs the pinned TypeScript 7
 * compiler's emit of the program with `experimentalDecorators` (and
 * `emitDecoratorMetadata`), then executes that JavaScript. Legacy decorators
 * are the one supported construct Node cannot execute at all, so the emit
 * TypeScript 7 produces — the same emit an application ships — is the
 * reference. Single-file programs only: the emit materializes one entry
 * beside the test cache, as the standard `@tsc-decorators` oracle does. */
export function wantsLegacyDecorators(head: readonly string[]): boolean {
  return head.some((line) => /^\/\/ @tsc-legacy-decorators\s*$/.test(line));
}

export function wantsDecoratorMetadata(head: readonly string[]): boolean {
  return head.some((line) => /^\/\/ @tsc-decorator-metadata\s*$/.test(line));
}

const require = createRequire(import.meta.url);
const typescriptManifest = require.resolve("typescript/package.json");
const tsc = join(dirname(typescriptManifest), "bin", "tsc");
/** The pinned TypeScript 7 version whose emit the legacy oracle runs; part
 * of the Node-oracle cache key. */
export const legacyDecoratorTypescriptVersion = (
  JSON.parse(readFileSync(typescriptManifest, "utf8")) as { version: string }
).version;
const typescriptVersion = legacyDecoratorTypescriptVersion;

/** The file the Node oracle executes for a legacy-decorator program: the
 * pinned TypeScript 7 emit's entry, as an ES module under the test cache.
 * The path is a pure function of the program bytes, the flags and the
 * TypeScript version. */
export function legacyDecoratorOracleEntry(
  file: string,
  cacheDir: string,
  options: { metadata: boolean },
): string {
  const src = readFileSync(file, "utf8");
  const key = createHash("sha256")
    .update("legacy-decorators\0")
    .update(typescriptVersion)
    .update(options.metadata ? "\0metadata" : "")
    .update("\0")
    .update(src)
    .digest("hex")
    .slice(0, 16);
  const entry = join(cacheDir, `legacy-dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  try {
    readFileSync(entry);
    return entry;
  } catch {
    // Not emitted yet: compile below.
  }
  const staging = join(cacheDir, `legacy-dec-build-${key}.${process.pid}`);
  const outDir = join(staging, "out");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        file,
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--experimentalDecorators",
        ...(options.metadata ? ["--emitDecoratorMetadata"] : []),
        "--strict",
        "--skipLibCheck",
        "--outDir",
        outDir,
      ],
      { stdio: "pipe" },
    );
    // Atomic publish: concurrent suites write this same content-keyed path.
    const tmp = `${entry}.${process.pid}.tmp`;
    copyFileSync(join(outDir, `${basename(file, ".ts")}.js`), tmp);
    renameSync(tmp, entry);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return entry;
}
