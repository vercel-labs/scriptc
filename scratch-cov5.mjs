import { analyze } from "./packages/compiler/dist/index.js";
const { coverage } = analyze("tests/corpus/async-hooks-execution-ids.cjs", {});
console.log(JSON.stringify(coverage.runtimeFences, null, 1).slice(0, 3000));
