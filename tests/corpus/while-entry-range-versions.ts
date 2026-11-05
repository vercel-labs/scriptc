// While loops whose remainder reads locals copied from module globals,
// parameters and fields. Entry values cover integers inside and outside
// [-2^48, 2^48], fractions, -0, NaN and infinities.

let column = 0;
let lines = 0;

// A switch with more cases than a small leaf function has statements.
function complement(code: number): number {
  switch (code) {
    case 65:
      return 84;
    case 67:
      return 71;
    case 71:
      return 67;
    case 84:
      return 65;
    case 97:
      return 116;
    case 99:
      return 103;
    case 103:
      return 99;
    case 116:
      return 97;
    case 85:
      return 65;
    case 117:
      return 97;
    case 82:
      return 89;
    case 89:
      return 82;
    case 75:
      return 77;
    case 77:
      return 75;
  }
  return 78;
}

// Copies bytes in reverse, complemented, with a newline after every 8
// columns counted from the module-level column and line counters.
function wrap(input: Uint8Array, out: Uint8Array): number {
  const base = column;
  let breaks = lines;
  let count = 0;
  let o = 0;
  let i = 0;
  const len = input.length;
  let last = 1;
  let negativeZeros = 0;
  while (i < len) {
    out[o] = complement(input[len - 1 - i]!);
    i++;
    o++;
    count++;
    last = (count + base - breaks) % 8;
    if (Object.is(last, -0)) negativeZeros++;
    if (last === 0) {
      out[o] = 10;
      o++;
      count++;
      breaks++;
    }
  }
  column = base + count;
  lines = breaks;
  console.log(`  last ${Object.is(last, -0) ? "-0" : last}, ${negativeZeros} of them -0`);
  return o;
}

function text(out: Uint8Array, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += out[i] === 10 ? "|" : String.fromCharCode(out[i]!);
  return s;
}

const input = new Uint8Array(29);
const bases = "ACGTTGCAAGCTTCGA";
for (let i = 0; i < input.length; i++) input[i] = bases.charCodeAt((i * 7) % bases.length);
const out = new Uint8Array(64);

const starts: [number, number][] = [
  [0, 0],
  [5, 2],
  [-13, 0],
  [-16, 0],
  [2 ** 48, 3],
  [-(2 ** 48), 0],
  [2 ** 48 + 1, 0],
  [2 ** 50, 1],
  [2 ** 53 - 5, 0],
  [2 ** 53, 0],
  [2 ** 53 + 2, 1],
  [0.5, 0],
  [3, 0.25],
  [3, 2 ** 49],
  [-0, 0],
  [0, -0],
  [NaN, 0],
  [Infinity, 0],
  [-Infinity, 0],
  [1e300, 0],
];
for (const [c, l] of starts) {
  column = c;
  lines = l;
  console.log(`start column ${c} lines ${l}`);
  const n = wrap(input, out);
  console.log(`  ${text(out, n)}`);
  console.log(`  column ${column} lines ${lines}`);
}

// Two calls in a row: the second starts from the first one's counters.
column = 3;
lines = 0;
wrap(input, out);
const n = wrap(input, out);
console.log(`again ${text(out, n)} column ${column} lines ${lines}`);

// A parameter and a field as the loop's entry values.
function ring(values: Int32Array, offset: number, size: number): number {
  let sum = 0;
  let i = 0;
  while (i < values.length) {
    sum += values[(i + offset) % size]!;
    i++;
  }
  return sum;
}
const values = new Int32Array([3, 1, 4, 1, 5, 9, 2, 6]);
for (const offset of [0, 3, 7, 2 ** 40, 2 ** 49, 1.5, -0, -2]) {
  const sum = ring(values, offset, values.length);
  console.log(`ring ${offset} ${Number.isNaN(sum) ? "NaN" : sum}`);
}

class Cursor {
  position: number;
  constructor(position: number) {
    this.position = position;
  }
  stripes(bytes: Uint8Array): string {
    const start = this.position;
    let i = 0;
    let marks = "";
    while (i < bytes.length) {
      const r = (start + i) % 3;
      marks += Object.is(r, -0) ? "z" : String(r);
      i++;
    }
    this.position = start + i;
    return marks;
  }
}
for (const position of [0, 4, -5, 2 ** 48 + 7, 0.75, 2 ** 60]) {
  const cursor = new Cursor(position);
  console.log(`stripes ${position} ${cursor.stripes(input.subarray(0, 7))} ${cursor.position}`);
}
