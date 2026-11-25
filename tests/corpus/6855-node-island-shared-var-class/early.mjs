import { requireModule } from "@scriptc/node";

// Loaded while neither shapes.mjs nor the package `kit` has run.
const island = requireModule("./island.mjs");
console.log("early:", island.hello());

export function area(side) {
  return island.area(side);
}

export function make(code) {
  return island.make(code);
}

export function check(e) {
  return island.check(e);
}

export function caught(code) {
  return island.caught(code);
}

export function sameClass(shape, error) {
  return island.sameClass(shape, error);
}

export function raise(code) {
  return island.raise(code);
}
