// A require cycle between esbuild's per-file CommonJS outputs (index ↔
// merge, index ↔ append). Each file installs its live getter table
// before its first require, so a partner that loads while index.js is
// still initializing sees index's partially initialized exports, and both
// partners call back into index from their functions. index.js re-exports
// mergeAll from merge.js through its getter table.
import { run, mergeAll } from "gtcycle";

console.log(run([" a ", "", "@x"], ["b", "@keep"]));
console.log(run(["c"], []));
console.log(mergeAll(["@keep", " d"], ["@drop"]).join("|"));
