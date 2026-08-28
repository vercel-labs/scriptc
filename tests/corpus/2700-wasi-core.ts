// The wasm32-wasi differential seed: pointer-width-sensitive heap objects
// (arrays, maps, and closure boxes) plus ordinary numeric/string output.
import { platform as osPlatform } from "node:os";

const values = [1, 2, 3, 4].map((n) => n * n);
const labels = new Map<string, number>();
labels.set("sum", values.reduce((a, b) => a + b, 0));

function counter(start: number): () => number {
  let n = start;
  return () => ++n;
}

const next = counter(labels.get("sum") ?? 0);
console.log(values.join(","));
console.log(next(), next());
console.log(`wasi-core:${labels.has("sum")}`);
console.log(process.platform === "wasi" ? process.arch === "wasm32" : osPlatform() === process.platform);
