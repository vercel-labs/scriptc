// node:module's source-map support in TypeScript: the support record starts
// disabled, setSourceMapsSupport sets the flags process.sourceMapsEnabled
// reads, and resetting through process.setSourceMapsEnabled clears the option
// flags again. A compiled program registers no source map, so findSourceMap
// answers undefined — what Node answers for a file whose map was never
// parsed.
import {
  findSourceMap,
  getSourceMapsSupport,
  setSourceMapsSupport,
} from "node:module";

const initial = getSourceMapsSupport();
console.log("initial", initial.enabled, initial.nodeModules, initial.generatedCode);
console.log(
  "record",
  getSourceMapsSupport() === initial,
  Object.isFrozen(initial),
  Object.getPrototypeOf(initial) === null,
  Object.keys(initial).join(","),
);

setSourceMapsSupport(true, { nodeModules: true, generatedCode: false });
const enabled = getSourceMapsSupport();
console.log("enabled", enabled.enabled, enabled.nodeModules, enabled.generatedCode);
console.log("same record", enabled === initial);
console.log("process", process.sourceMapsEnabled);

process.setSourceMapsEnabled(false);
const reset = getSourceMapsSupport();
console.log("reset", reset.enabled, reset.nodeModules, reset.generatedCode);
console.log("process after reset", process.sourceMapsEnabled);

setSourceMapsSupport(true);
console.log(
  "no options",
  getSourceMapsSupport().enabled,
  getSourceMapsSupport().nodeModules,
  getSourceMapsSupport().generatedCode,
  process.sourceMapsEnabled,
);

setSourceMapsSupport(false);
console.log("off", getSourceMapsSupport().enabled, process.sourceMapsEnabled);

console.log(
  "find",
  findSourceMap("/tmp/module-source-maps-none.js"),
  findSourceMap("file:///tmp/module-source-maps-none.js"),
  findSourceMap("node:fs"),
  findSourceMap("data:text/javascript,1"),
);

try {
  setSourceMapsSupport(1 as unknown as boolean);
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  console.log("enabled number", e instanceof TypeError, e.code, e.name, e.message);
}
try {
  setSourceMapsSupport(true, 5 as unknown as { nodeModules?: boolean });
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  console.log("options number", e instanceof TypeError, e.code, e.name, e.message);
}
