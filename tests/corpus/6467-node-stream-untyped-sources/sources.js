import * as fs from "node:fs";
import { PassThrough } from "node:stream";

const parts = [];

/** @returns {any} */
export function openUntyped(file) {
  return fs.createReadStream(file);
}

/** @returns {any} */
export function collector() {
  const sink = new PassThrough();
  sink.on("data", (chunk) => parts.push(chunk.toString("utf8")));
  return sink;
}

export function joined() {
  return parts.splice(0).join("");
}
