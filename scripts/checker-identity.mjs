#!/usr/bin/env node
// Compiles every corpus program to LLVM IR with each TypeScript 7 API server (tsc-ts, the default, and tsgo with
// SCRIPTC_CHECKER=tsgo) and fails unless both give the same IR and the same diagnostics. The text of a checker panic
// is the checker's own (Go's runtime error for tsgo, tsc-ts's for tsc-ts), so it is compared as `panic: …`.
//
// Usage: node scripts/checker-identity.mjs [--jobs <n>] [--optimization release|dev] [--filter <substring>]
//
// It needs `pnpm build`. Each checker compiles in its own worker processes, which read SCRIPTC_CHECKER when they
// start their servers.
import { fork } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(repoRoot, "tests/corpus");
const checkers = ["tsgo", "tsc-ts"];

if (process.argv[2] === "--worker") await worker(process.argv.slice(3));
else await main();

async function main() {
  const { values } = parseArgs({
    options: {
      jobs: {
        type: "string",
        default: String(Math.max(1, Math.floor(availableParallelism() / 2))),
      },
      optimization: { type: "string", default: "release" },
      filter: { type: "string", default: "" },
    },
  });
  if (values.optimization !== "release" && values.optimization !== "dev")
    throw new Error("--optimization must be release or dev");
  // The entries llvm-differential.test.ts compiles.
  const entries = ["ts", "js", "mjs", "cjs"]
    .flatMap((ext) => [
      ...globSync(join(corpusDir, `*.${ext}`)),
      ...globSync(join(corpusDir, `*/main.${ext}`)),
    ])
    .filter((file) => file.includes(values.filter))
    .sort();
  const jobs = Math.max(1, Number(values.jobs));
  const outRoot = mkdtempSync(join(tmpdir(), "scriptc-checker-identity-"));
  try {
    const results = new Map(checkers.map((checker) => [checker, new Map()]));
    const runs = [];
    for (const checker of checkers)
      for (let index = 0; index < jobs; index++)
        runs.push(
          new Promise((done, fail) => {
            const child = fork(
              fileURLToPath(import.meta.url),
              [
                "--worker",
                join(outRoot, checker),
                values.optimization,
                ...entries.filter((_, i) => i % jobs === index),
              ],
              { env: { ...process.env, SCRIPTC_CHECKER: checker } },
            );
            child.on("message", (record) => results.get(checker).set(record.file, record));
            child.on("error", fail);
            child.on("exit", (code) =>
              code === 0 ? done() : fail(new Error(`${checker} worker exited with ${code}`)),
            );
          }),
        );
    await Promise.all(runs);
    const differences = [];
    for (const file of entries) {
      const [a, b] = checkers.map((checker) => results.get(checker).get(file));
      const name = file.slice(corpusDir.length + 1);
      if (a === undefined || b === undefined) differences.push(`${name}: not compiled`);
      else if (a.ok !== b.ok || withoutPanicText(a.diagnostics) !== withoutPanicText(b.diagnostics))
        differences.push(
          `${name}: tsgo ${a.ok ? "compiles" : a.diagnostics}; tsc-ts ${b.ok ? "compiles" : b.diagnostics}`,
        );
      else if (a.ok && irWithoutPanicText(a.llvm) !== irWithoutPanicText(b.llvm))
        differences.push(`${name}: LLVM IR differs`);
    }
    if (differences.length > 0) {
      console.error(
        `${differences.length} of ${entries.length} programs differ between tsgo and tsc-ts:`,
      );
      for (const line of differences) console.error(`  ${line}`);
      process.exitCode = 1;
    } else {
      console.log(
        `${entries.length} programs: tsgo and tsc-ts give the same LLVM IR and diagnostics (${values.optimization}).`,
      );
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}

/** A diagnostic list with each SC0004 checker panic's text replaced by `…`. */
function withoutPanicText(diagnostics) {
  return diagnostics?.replace(/(SC0004: [^;]*?: panic: )[^;]*/g, "$1…");
}

/** A module's LLVM IR with each SC0004 checker panic's text replaced by `…`. A fence statement keeps the
 * diagnostic's message in a string constant named for a hash of its contents, and passes its length. */
function irWithoutPanicText(llvm) {
  let ir = readFileSync(llvm, "utf8");
  const constant =
    /^(@sc_cs_\d+) = internal constant \[\d+ x i8\] c"(the TypeScript checker crashed answering a query here [^"]*?: panic: )[^"]*?( \[SC0004 at [^"]*)"$/gm;
  const names = [];
  ir = ir.replace(constant, (_, name, head, tail) => {
    names.push(name);
    return `@checker_panic_${names.length} = internal constant c"${head}…${tail}"`;
  });
  names.forEach((name, index) => {
    ir = ir.replace(
      new RegExp(`${name}\\b(, i64 \\d+)?`, "g"),
      (_, length) => `@checker_panic_${index + 1}${length === undefined ? "" : ", i64 …"}`,
    );
  });
  return ir;
}

async function worker([outDir, optimization, ...files]) {
  const { compile } = await import(
    pathToFileURL(join(repoRoot, "packages/compiler/dist/index.js")).href
  );
  for (const file of files) {
    const name = file.slice(corpusDir.length + 1);
    const llvm = join(outDir, `${name}.ll`);
    let record;
    try {
      const result = await compile(file, {
        outputKind: "llvm",
        outPath: llvm,
        outDir: join(outDir, ".work", name),
        optimization,
      });
      record = result.ok
        ? { file, ok: true, llvm }
        : {
            file,
            ok: false,
            diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "),
          };
    } catch (error) {
      record = {
        file,
        ok: false,
        diagnostics: `threw ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    process.send(record);
  }
}
