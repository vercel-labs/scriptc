// if/else-if chains that store one of several literals to one typed-array
// element, chosen by comparing one number with integer literals: the
// subject's values that no case names, repeated and negative cases,
// results that do not fit the element, and chains that keep their arms.

function bases(arr: Uint8Array): void {
  for (let i = 0; i < arr.length; ++i) {
    const x = arr[i];
    if (x === 97) arr[i] = 0;
    else if (x === 116) arr[i] = 1;
    else if (x === 99) arr[i] = 2;
    else arr[i] = 3;
  }
}

const sequence = new Uint8Array(64);
for (let i = 0; i < sequence.length; i++) sequence[i] = "actgACTGnx"[i % 10]!.charCodeAt(0);
bases(sequence);
console.log("bases", sequence.join(""));

// A number subject: NaN, -0, fractions, infinities and values far outside the cases.
const subjects = [0, -0, 1, 2, 3, 4, -1, 0.5, 2.0000001, NaN, Infinity, -Infinity, 2 ** 40, -(2 ** 40), 1e300];
function classify(out: Int16Array, at: number, v: number): void {
  if (v === 0) out[at] = 10;
  else if (v === 1) out[at] = -20;
  else if (v === 2) out[at] = 30;
  else if (v === 1) out[at] = 99; // never reached
  else if (v === -1) out[at] = 40;
  else out[at] = -50;
}
const classes = new Int16Array(subjects.length);
for (let i = 0; i < subjects.length; i++) classify(classes, i, subjects[i]!);
console.log("classes", classes.join(" "));

// The literal on the left, and results the element converts: 300 wraps in a
// Uint8Array, -1 is 255, 1.5 truncates, and a clamped array rounds and clamps.
function convert(u8: Uint8Array, c: Uint8ClampedArray, f: Float64Array, i: Int8Array, v: number): void {
  if (5 === v) u8[0] = 300;
  else if (6 === v) u8[0] = -1;
  else if (7 === v) u8[0] = 1.5;
  else u8[0] = 8589934599; // 2 ** 33 + 7
  if (v === 5) c[0] = 300;
  else if (v === 6) c[0] = -1;
  else if (v === 7) c[0] = 2.5;
  else c[0] = 3.5;
  if (v === 5) f[0] = 0.25;
  else if (v === 6) f[0] = -0;
  else if (v === 7) f[0] = 1e300;
  else f[0] = NaN;
  if (v === 5) i[0] = 128;
  else if (v === 6) i[0] = -129;
  else if (v === 7) i[0] = -128;
  else i[0] = 127;
}
for (const v of [5, 6, 7, 8, NaN]) {
  const u8 = new Uint8Array(1);
  const c = new Uint8ClampedArray(1);
  const f = new Float64Array(1);
  const i = new Int8Array(1);
  convert(u8, c, f, i, v);
  console.log("convert", v, u8[0], c[0], Object.is(f[0], -0) ? "-0" : f[0], i[0]);
}

// An index past the end ignores the store, whatever the chain chooses.
const short = new Uint8Array(2);
for (let k = 0; k < 4; k++) {
  const v = k + 1;
  if (v === 1) short[k] = 11;
  else if (v === 2) short[k] = 22;
  else if (v === 3) short[k] = 33;
  else short[k] = 44;
}
console.log("short", short.join(","));

// The index is the compared local. Inside each arm the range analysis
// proves its value there; on the final else's path it is past the end, also
// past 2^32 and below -2^32, and the store is ignored.
function indexed(flag: boolean): string {
  const a = new Uint8Array(4);
  let j = 0;
  if (flag) j = 4294967297;
  if (j === 0) a[j] = 11;
  else if (j === 1) a[j] = 22;
  else if (j === 2) a[j] = 33;
  else a[j] = 44;
  return a.join(",");
}
function indexedLoop(): string {
  const a = new Uint8Array(8);
  for (let k = 0; k < 4; k++) {
    let j = 1;
    if (k === 3) j = 5;
    else if (k === 2) j = 4294967298;
    else if (k === 1) j = -4294967294;
    if (j === 1) a[j] = 11;
    else if (j === 2) a[j] = 22;
    else if (j === 3) a[j] = 33;
    else a[j] = 44;
  }
  return a.join(",");
}
console.log("indexed", indexed(false), indexed(true), indexedLoop());

// Chains that keep their arms: an arm with a second statement, no final
// else, a different index, and a subject that is not a local.
let calls = 0;
function count(): number {
  calls++;
  return 9;
}
const kept = new Uint8Array(8);
for (let k = 0; k < 8; k++) {
  const v = k % 5;
  if (v === 0) kept[k] = 1;
  else if (v === 1) {
    kept[k] = 2;
    calls += 100;
  } else if (v === 2) kept[k] = 3;
  else kept[k] = 4;
  if (v === 0) kept[0] += 1;
  else if (v === 1) kept[0] += 2;
  else if (v === 2) kept[0] += 3;
  if (count() === v) kept[k] = 7;
  else if (v === 3) kept[(k + 1) % 8] = 5;
  else if (v === 4) kept[k] = 6;
  else kept[k] = kept[k]!;
}
console.log("kept", kept.join(","), calls);
