#!/usr/bin/env node
/* Compares two LLVM helpers on the helper inputs of this checkout
 * (scripts/llvm-helper-inputs.mjs): every input must give identical objects
 * with both, and the script prints each input group's median wall time per
 * helper over the rounds, with the candidate/baseline ratio. The llvm-dist
 * workflow runs it with the helper linked against LLVM's release archive as
 * the baseline and the one linked against the profiled ThinLTO distribution
 * as the candidate, on each architecture it builds. Exits with status 1 when
 * an object differs.
 *
 *   node scripts/check-llvm-dist.mjs --baseline <helper> --candidate <helper>
 *     [--rounds N] [--work <dir>] [--tsc-ts <checkout>] [--extra <dir of .ts programs>]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { captureHelperInputs, helperInputPrograms } from "./llvm-helper-inputs.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    rounds: { type: "string", default: "3" },
    work: { type: "string" },
    "tsc-ts": { type: "string" },
    extra: { type: "string", multiple: true, default: [] },
    help: { type: "boolean", default: false },
  },
});
if (values.help || values.baseline === undefined || values.candidate === undefined) {
  console.log(
    "Usage: node scripts/check-llvm-dist.mjs --baseline <helper> --candidate <helper> [--rounds N] [--work <dir>] [--tsc-ts <checkout>] [--extra <dir>]",
  );
  process.exit(values.help ? 0 : 2);
}
const helpers = { baseline: resolve(values.baseline), candidate: resolve(values.candidate) };
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-llvm-check-")));
const inputs = await captureHelperInputs(
  helperInputPrograms({
    tscTs: values["tsc-ts"] === undefined ? undefined : resolve(values["tsc-ts"]),
    extra: values.extra.map((dir) => resolve(dir)),
  }),
  join(work, "inputs"),
);

function emit(helper, input, out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const start = performance.now();
  const result = spawnSync(helper, input.args(out), { encoding: "utf8" });
  const ms = performance.now() - start;
  if (result.status !== 0)
    throw new Error(`${helper} failed on ${input.name}: ${result.stdout}${result.stderr}`);
  return ms;
}

const times = new Map(); // `${group}|${helper}` -> per-round totals
const group = (name) => (name === "tsc-ts" ? name : name.split("-")[0]);
const rounds = Number(values.rounds);
let differing = 0;
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  for (const input of inputs) {
    for (const which of order) {
      const ms = emit(helpers[which], input, join(work, which));
      const key = `${group(input.name)}|${which}`;
      const totals = times.get(key) ?? new Array(rounds).fill(0);
      totals[round] += ms;
      times.set(key, totals);
    }
    if (round === 0) {
      for (const file of readdirSync(join(work, "baseline"))) {
        const a = readFileSync(join(work, "baseline", file));
        const b = readFileSync(join(work, "candidate", file));
        if (!a.equals(b)) {
          differing++;
          console.log(`${input.name}: ${file} differs between the helpers`);
        }
      }
    }
  }
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.log(`${inputs.length} inputs, ${rounds} rounds; median wall time per group`);
console.log("| group | baseline | candidate | candidate/baseline |");
console.log("| --- | ---: | ---: | ---: |");
for (const name of [...new Set(inputs.map((input) => group(input.name)))]) {
  const b = median(times.get(`${name}|baseline`)),
    c = median(times.get(`${name}|candidate`));
  console.log(
    `| ${name} | ${(b / 1000).toFixed(2)} s | ${(c / 1000).toFixed(2)} s | ${(c / b).toFixed(3)} |`,
  );
}
if (differing > 0) {
  console.log(`${differing} objects differ between the helpers`);
  process.exit(1);
}
console.log("every object is identical between the helpers");
