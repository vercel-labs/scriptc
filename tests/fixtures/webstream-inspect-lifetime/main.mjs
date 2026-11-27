// Inspecting streams repeatedly builds each view's fields (the state strings
// among them) and releases them with the view. Prints the resident-set
// growth in MiB after a warm-up.
import { inspect } from "node:util";

const streams = [
  new ReadableStream(),
  new WritableStream(),
  new TransformStream(),
  new CountQueuingStrategy({ highWaterMark: 2 }),
  new TextEncoderStream(),
];
function round(n) {
  for (let i = 0; i < n; i++) for (const value of streams) inspect(value);
}
round(200);
const before = process.memoryUsage().rss;
round(100000);
console.log(Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
