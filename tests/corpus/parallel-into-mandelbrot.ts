import { parallelInto } from "@scriptc/experimental";

// Parallel loops (@scriptc/experimental): the body of parallelInto writes
// only the `part` it is given, so its chunks may run on several threads.
// Each pixel depends on its own coordinates alone, so every thread count
// prints the same numbers; Node.js runs the chunks in order.

const width = 96;
const height = 72;
const pixels = new Uint8Array(width * height);

parallelInto(
  pixels,
  (part, start, end) => {
    for (let y = start; y < end; y++) {
      const ci = (y - height / 2) / (height / 4);
      for (let x = 0; x < width; x++) {
        const cr = (x - width / 2) / (width / 4);
        let zr = 0;
        let zi = 0;
        let iter = 0;
        while (iter < 60) {
          const next = zr * zr - zi * zi + cr;
          zi = 2 * zr * zi + ci;
          zr = next;
          if (zr * zr + zi * zi > 4) break;
          iter++;
        }
        part[(y - start) * width + x] = iter * 4;
      }
    }
  },
  { grain: 4 },
);

let sum = 0;
let deep = 0;
for (let i = 0; i < pixels.length; i++) {
  sum += pixels[i]!;
  if (pixels[i]! >= 240) deep++;
}
console.log(sum, deep);
console.log(pixels[0], pixels[width * 36 + 48], pixels[pixels.length - 1]);
