// The bundled-chunk shape: a loader created once at the chunk's top level
// and exported, so importing modules reach the same require function.
import { createRequire } from "node:module";

export const __require = createRequire(import.meta.url);

export function readKey() {
  return __require("./data.json").key.toUpperCase();
}

export function loaderType() {
  return typeof __require;
}
