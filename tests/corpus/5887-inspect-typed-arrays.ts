// util.inspect, console.log and console.dir print a numeric typed array
// that is not a Buffer as Node does: `Float64Array(n) [ ... ]` with the
// number formatting, the 100-element maxArrayLength tail, the array grid
// and `[Int16Array]` past the depth limit. Typed arrays other than
// Uint8Array also print inside records and arrays, and under the
// breakLength, compact and sorted options; Buffers keep their <Buffer ..>
// form.
import { inspect } from "node:util";

console.log(new Uint8Array([1, 2, 3]), new Uint8Array(0));
console.log(new Float64Array([1.5, -0, Number.NaN, Infinity, -1e21]));
console.log(new Float32Array([0.1, 16777217]));
console.log(new Int32Array(30));
console.log(new Uint8ClampedArray([300, -5, 1.5]), new Int8Array([-1, 127, 128]));
console.log(inspect(new Uint16Array(150)));
console.log({ samples: new Uint16Array([7, 8]), deltas: new Int8Array([-1, 2]) });
console.log([new Float32Array([1, 2]), new Float32Array(10)]);
console.log(inspect({ x: { y: { z: new Uint32Array([1]) } } }), inspect(new Int16Array([5]), { depth: 0 }));
console.log(inspect({ x: { y: new Int16Array([5]) } }, { depth: 1 }));
console.dir(new Uint8Array([4, 5]));
console.log(new Uint8Array([1, 2, 3, 4]).subarray(1, 3), new Uint8Array(Buffer.from("hi")), Buffer.from("hi"));
const grid = new Float64Array(12);
for (let i = 0; i < grid.length; i++) grid[i] = i * 1.25;
console.log(grid);
const wide = new Uint8Array(40);
for (let i = 0; i < wide.length; i++) wide[i] = i * 7;
console.log(inspect(wide, { breakLength: 40 }));
console.log(inspect(new Int16Array([1, -2, 300, -4000, 5]), { compact: false }));
console.log(inspect(new Uint32Array(120), { depth: 0, breakLength: 60 }));
console.log(inspect(new Int8Array([3, 1, 2]), { sorted: true, breakLength: Infinity }));
