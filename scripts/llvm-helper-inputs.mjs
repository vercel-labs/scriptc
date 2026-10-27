/* Inputs of the LLVM helper, captured once and replayed with any helper:
 * scripts/refresh-llvm-profile.mjs trains the helper's profile on them and
 * scripts/check-llvm-dist.mjs compares helpers on them. Each input is a
 * program's LLVM text from `scriptc build --emit llvm` and the `emit`
 * arguments the compiler passes for an executable build of it
 * (native-codegen.ts), partitions included. The partition cache is left out,
 * so every replay compiles every partition. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const EFFECT_FIXTURES = [
  "async-sleep",
  "async-promise-typed",
  "async-timeout",
  "async-resume-timer",
  "async-yield",
];

/** The programs: tsc-ts (when a checkout is given), five Effect fixtures,
 * the runtime benchmark workloads, every 50th numbered corpus program, and
 * `extra` directories of standalone programs. */
export function helperInputPrograms({ tscTs, extra = [] } = {}) {
  const programs = [];
  if (tscTs !== undefined)
    programs.push({ name: "tsc-ts", cwd: join(tscTs, "packages/tsc-ts"), entry: "src/main.ts" });
  for (const fixture of EFFECT_FIXTURES)
    programs.push({
      name: `effect-${fixture}`,
      cwd: root,
      entry: `tests/fixtures/effect/${fixture}.ts`,
      args: ["--npm-static", "effect,fast-check,pure-rand"],
    });
  const suite = join(root, "benchmarks/runtime");
  for (const file of readdirSync(join(suite, "workloads"))
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const { entry } = JSON.parse(readFileSync(join(suite, "workloads", file), "utf8"));
    // Variants of a workload share its entry and differ only in arguments.
    if (!programs.some((program) => program.cwd === suite && program.entry === entry))
      programs.push({ name: `wl-${file.slice(0, -5)}`, cwd: suite, entry });
  }
  const corpus = join(root, "tests/corpus");
  for (const file of readdirSync(corpus).sort()) {
    const number = /^(\d+)-.*\.ts$/.exec(file)?.[1];
    if (number !== undefined && Number(number) % 50 === 0)
      programs.push({ name: `corpus-${file.slice(0, -3)}`, cwd: corpus, entry: file });
  }
  for (const dir of extra)
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .sort())
      programs.push({ name: `extra-${file.slice(0, -3)}`, cwd: dir, entry: file });
  return programs;
}

/** Writes `<dir>/<name>.ll` for each program with this checkout's compiler
 * and returns the inputs that compiled: `{ name, input, outputs, args(out) }`,
 * where `args(out)` gives the helper's arguments writing into `out`. */
export async function captureHelperInputs(programs, dir) {
  const { nativeProgramPartitions } = await import(
    join(root, "packages/compiler/dist/backend/native-codegen-core.js")
  );
  const cli = join(root, "packages/cli/dist/main.js");
  const target =
    process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  mkdirSync(dir, { recursive: true });
  const inputs = [];
  for (const program of programs) {
    const input = join(dir, `${program.name}.ll`);
    if (!existsSync(input)) {
      const built = spawnSync(
        process.execPath,
        [cli, "build", program.entry, "--emit", "llvm", "-o", input, ...(program.args ?? [])],
        { cwd: program.cwd, encoding: "utf8" },
      );
      if (built.status !== 0) {
        console.log(`skipped ${program.name}: the compiler refused it`);
        continue;
      }
    }
    const partitions = nativeProgramPartitions(statSync(input).size);
    const source = join(program.cwd, program.entry);
    inputs.push({
      name: program.name,
      input,
      partitions,
      args: (out) => [
        "emit",
        "--input",
        input,
        ...Array.from({ length: partitions }, (_, i) => [
          "--output",
          join(out, `${program.name}.part${i}.o`),
        ]).flat(),
        "--filetype",
        "obj",
        "--target",
        target,
        "--opt-level",
        "2",
        "--relocation-model",
        "pic",
        "--diagnostic-format",
        "json",
        "--source-path",
        source,
      ],
    });
  }
  return inputs;
}
