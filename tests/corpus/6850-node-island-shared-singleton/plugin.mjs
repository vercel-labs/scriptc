// Island code (loaded with requireModule): imports the shared module by
// named imports, by namespace, and through require().
import { createRequire } from "node:module";
import * as ns from "./state.mjs";
import { config, count, entries, record } from "./state.mjs";

const require = createRequire(import.meta.url);

record("island-1");
export const startup = `count=${count} ns=${ns.count} entries=${entries()}`;

export function report() {
  return `count=${count} ns=${ns.count} entries=${entries()}`;
}

export function bump(name) {
  const before = count;
  const after = record(name);
  return `${before}->${after} live=${count}`;
}

export function configure(mode) {
  config.mode = mode;
}

export function describeConfig() {
  return `${config.mode}/${config.owner}`;
}

export function sameRecord(fn) {
  return fn === record && fn === ns.record;
}

export function requireSees() {
  const viaRequire = require("./state.mjs");
  return viaRequire === ns && viaRequire.entries() === entries();
}
