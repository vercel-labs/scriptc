// Loops that read one typed array and write another, where the two views
// may share bytes: overlapping and disjoint views of one buffer, the same
// array passed twice, views of different element types over one buffer,
// and empty views, and passes whose views an enclosing loop swaps. A loop
// over views that overlap must see its own writes, and each pass the
// previous pass's writes.
function shiftAdd(dst: Float64Array, src: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) dst[i] = src[i]! + 1;
}

function mixed(bytes: Uint8Array, words: Float64Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    words[i] = i * 0.5 + 1;
    sum += bytes[i]!;
  }
  return sum;
}

function lanes(zr: Float64Array, zi: Float64Array, tr: Float64Array, ti: Float64Array): number {
  for (let step = 0; step < 6; step++)
    for (let k = 0; k < 4; k++) {
      const r = zr[k]!;
      const i = zi[k]!;
      zi[k] = 2 * r * i + 0.25;
      zr[k] = tr[k]! - ti[k]! - 0.5;
      tr[k] = zr[k]! * zr[k]!;
      ti[k] = zi[k]! * zi[k]!;
    }
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += zr[k]! + zi[k]! + tr[k]! + ti[k]!;
  return sum;
}

function show(a: Float64Array): string {
  const parts: string[] = [];
  for (let i = 0; i < a.length; i++) parts.push(a[i]!.toFixed(3));
  return parts.join(",");
}

// Disjoint arrays.
const a = new Float64Array([1, 2, 3, 4]);
const b = new Float64Array(4);
shiftAdd(b, a, 4);
console.log("disjoint", show(b));

// One array as both views: each element reads its own old value.
const same = new Float64Array([1, 2, 3, 4]);
shiftAdd(same, same, 4);
console.log("same", show(same));

// Overlapping views of one buffer: the destination starts one element
// after the source, so every read sees the previous iteration's write.
const buffer = new ArrayBuffer(8 * 8);
const whole = new Float64Array(buffer);
whole.fill(1);
shiftAdd(new Float64Array(buffer, 8, 6), new Float64Array(buffer, 0, 6), 6);
console.log("overlap forward", show(whole));
whole.fill(1);
shiftAdd(new Float64Array(buffer, 0, 6), new Float64Array(buffer, 8, 6), 6);
console.log("overlap backward", show(whole));

// Adjacent views of one buffer share no bytes.
whole.set([1, 2, 3, 4, 5, 6, 7, 8]);
shiftAdd(new Float64Array(buffer, 32, 4), new Float64Array(buffer, 0, 4), 4);
console.log("adjacent", show(whole));

// A byte view over the doubles it writes.
const shared = new ArrayBuffer(64);
console.log("mixed", mixed(new Uint8Array(shared), new Float64Array(shared), 8), show(new Float64Array(shared)));
console.log("mixed disjoint", mixed(new Uint8Array(new ArrayBuffer(64)), new Float64Array(8), 8));

// Empty views.
shiftAdd(new Float64Array(0), new Float64Array(0), 0);
console.log("empty", new Float64Array(0).length);

// Four lanes in separate arrays, and the same arrays aliased.
const lane = (): Float64Array => new Float64Array([0.1, -0.2, 0.3, -0.4]);
console.log("lanes", lanes(lane(), lane(), lane(), lane()).toFixed(6));
const one = lane();
console.log("lanes aliased", lanes(one, one, lane(), lane()).toFixed(6));
const pool = new Float64Array(16);
pool.set([0.1, -0.2, 0.3, -0.4, 0.1, -0.2, 0.3, -0.4, 0.1, -0.2, 0.3, -0.4, 0.1, -0.2, 0.3, -0.4]);
console.log(
  "lanes subarrays",
  lanes(pool.subarray(0, 4), pool.subarray(4, 8), pool.subarray(8, 12), pool.subarray(12, 16)).toFixed(6),
);
console.log(
  "lanes overlapping",
  lanes(pool.subarray(0, 4), pool.subarray(2, 6), pool.subarray(8, 12), pool.subarray(9, 13)).toFixed(6),
);

// Ping-pong passes: an enclosing loop swaps the two views after every pass,
// so each pass reads what the previous one wrote.
function pingPongPairs(a: Float64Array, b: Float64Array, steps: number): string {
  let cur = a;
  let next = b;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < 2; i++) next[i] = cur[i]! + cur[1 - i]! * 2 + s;
    const t = cur;
    cur = next;
    next = t;
  }
  return Array.from(cur).join(",");
}
function pingPongWords(a: Int32Array, b: Int32Array): string {
  let cur = a;
  let next = b;
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 4; i++) next[i] = (cur[i]! * 3 + cur[(i + 1) & 3]! + 1) | 0;
    const t = cur;
    cur = next;
    next = t;
  }
  return Array.from(cur).join(",");
}
function pingPongRows(a: Float64Array, b: Float64Array, steps: number): number {
  let cur = a;
  let next = b;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < cur.length; i++) next[i] = cur[i]! * 0.5 + 1;
    const t = cur;
    cur = next;
    next = t;
  }
  let sum = 0;
  for (let i = 0; i < cur.length; i++) sum += cur[i]!;
  return sum;
}
for (let k = 0; k < 3; k++) {
  console.log("ping-pong pairs", pingPongPairs(new Float64Array([1, 2]), new Float64Array(2), 3 + k));
  console.log("ping-pong words", pingPongWords(new Int32Array([1, 2, 3, 4]), new Int32Array(4)));
}
console.log("ping-pong rows", pingPongRows(new Float64Array(37).fill(8), new Float64Array(37), 9));
