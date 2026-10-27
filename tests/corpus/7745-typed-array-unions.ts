// Unions of typed-array classes: every element operation runs on each arm.

type UintArray = Uint8Array | Uint16Array | Uint32Array;
type Samples = Int16Array | Float32Array | Float64Array;

function uintArray(max: number, size: number): UintArray {
  return max <= 2 ** 8
    ? new Uint8Array(size)
    : max <= 2 ** 16
      ? new Uint16Array(size)
      : new Uint32Array(size);
}

function samples(kind: number, size: number): Samples {
  return kind === 0
    ? new Int16Array(size)
    : kind === 1
      ? new Float32Array(size)
      : new Float64Array(size);
}

function sum(xs: UintArray): number {
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += xs[i]!;
  return total;
}

function describe(xs: UintArray): string {
  if (xs instanceof Uint8Array) return `u8 ${xs.length}`;
  if (xs instanceof Uint16Array) return `u16 ${xs[0]}`;
  return `u32 ${xs.BYTES_PER_ELEMENT}`;
}

for (const max of [200, 60000, 5000000]) {
  const xs = uintArray(max, 6);
  // Stores convert to each arm's element kind (wrapping past its range).
  for (let i = 0; i < xs.length; i++) xs[i] = i * 70000 + 255;
  console.log(xs.length, xs.byteLength, xs.byteOffset, xs.BYTES_PER_ELEMENT);
  console.log(xs[0], xs[5], xs[6], xs[-1], sum(xs));
  xs[1] += 3;
  xs[2]++;
  --xs[3];
  xs[4] = -1;
  xs[5] = 2.75;
  console.log(xs[1], xs[2], xs[3], xs[4], xs[5]);
  // Writes past the end are ignored, and reads there are undefined.
  xs[10] = 9;
  console.log(xs[10] === undefined, xs[10] ?? "missing");
  let iterated = 0;
  for (const v of xs) iterated += v;
  console.log(iterated, [...xs].length, Array.from(xs)[1]);
  const part = xs.subarray(1, 4);
  part[0] = 42;
  console.log(part.length, xs[1], xs.slice(2, 4).length, xs.slice(2, 4)[0] === xs[2]);
  xs.fill(7, 4);
  xs.copyWithin(0, 4, 5);
  console.log(xs.join("-"), xs.toReversed()[0]);
  xs.set([1, 2], 2);
  console.log(xs[2], xs[3], describe(xs));
}

for (const kind of [0, 1, 2]) {
  const s = samples(kind, 4);
  s[0] = 1.5;
  s[1] = -40000;
  s[2] = 0.1;
  s[3] = s[0]! * 3;
  console.log(s.BYTES_PER_ELEMENT, s[0], s[1], s[2], s[3]);
  console.log(s);
  console.log(s instanceof Float32Array, s instanceof Int16Array);
}

// A stored value that reassigns the receiver or index stores into the
// receiver and at the index evaluated before it.
type Wide = Uint8Array | Uint16Array;
function rebound(wide: boolean): void {
  const before: Wide = wide ? new Uint16Array(4) : new Uint8Array(4);
  let u: Wide = before;
  let i = 0;
  const swap = (): number => {
    u = new Uint16Array(4);
    i = 2;
    return 300;
  };
  u[i] = swap();
  console.log(before, u, i);
  const target = u;
  target[1] = 5;
  u[i] += swap();
  console.log(target, u, i);
}
rebound(false);
rebound(true);
