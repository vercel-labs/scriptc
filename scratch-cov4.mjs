import { analyze } from "./packages/compiler/dist/index.js";
const { coverage } = analyze("tests/corpus/async-hooks-execution-ids.cjs", {});
console.log("keys:", Object.keys(coverage));
console.log("stats:", JSON.stringify(coverage.stats));
const extra = coverage.deferred ?? coverage.failures ?? coverage.fences;
console.log("extra:", JSON.stringify(extra)?.slice(0, 1500));
