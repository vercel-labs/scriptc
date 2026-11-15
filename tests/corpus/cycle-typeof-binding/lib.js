import { document } from "./dom.ts";

function probe() {
  try {
    return typeof document;
  } catch (e) {
    return e.name + ": " + e.message;
  }
}

function guarded() {
  try {
    return typeof document !== "undefined" ? "defined" : "undefined";
  } catch (e) {
    return e.name;
  }
}

console.log("module top level: " + probe() + ", " + guarded());

export function early() {
  return probe() + ", " + guarded();
}

export function label() {
  return `dom: ${typeof document}`;
}

export function describe(node) {
  return node.nodeName + (typeof document !== "undefined" ? " (dom)" : " (no dom)");
}
