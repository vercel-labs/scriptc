// For loops that advance positions carried in from outside the loop
// (`out[o++] = f(src[i++])` in a loop of `line` passes). Entry positions and
// pass counts cover integers inside and outside [-2^48, 2^48], fractions,
// -0, NaN and infinities.

function code(rand: number): number {
  if (rand < 0.25) return 97;
  if (rand < 0.5) return 99;
  if (rand < 0.75) return 103;
  return 116;
}

// Lines of `line` codes, each followed by a newline, from `start` on.
function lines(input: Float64Array, output: Uint8Array, count: number, start: number): number {
  let i = start;
  let o = start;
  while (count > 0) {
    const line = Math.min(count, 6);
    for (let j = 0; j < line; j++) output[o++] = code(input[i++]!);
    output[o++] = 10;
    count -= line;
  }
  return o + i / 1000;
}

// Writes backwards from `o`, reading forwards from `i`, with prefix steps.
function reverse(input: Float64Array, output: Uint8Array, line: number, i: number, o: number): string {
  for (let j = 0; j < line; j++) output[--o] = code(input[++i]!);
  return `${i} ${o}`;
}

// Leaves the loop with a return that reads both positions.
function find(input: Float64Array, line: number, i: number, o: number): number {
  for (let j = 0; j < line; j++) {
    if (input[i++]! > 0.9) return i * 1000 + o;
    o++;
  }
  return -(i * 1000 + o);
}

// The initializer writes a carried position.
function restart(input: Float64Array, output: Uint8Array, line: number, o: number): number {
  let i = 3;
  for (let j = (i = 0); j < line; j++) output[o++] = code(input[i++]!);
  return i * 100 + o;
}

// A callee that throws partway through the loop.
function guarded(input: Float64Array, output: Uint8Array, line: number, i: number): number {
  let o = 0;
  for (let j = 0; j < line; j++) {
    const rand = input[i++]!;
    if (rand > 0.91) throw new RangeError(`stop at ${i} ${o}`);
    output[o++] = code(rand);
  }
  return o;
}

const input = new Float64Array(64);
let seed = 42;
for (let k = 0; k < input.length; k++) {
  seed = (seed * 3877 + 29573) % 139968;
  input[k] = seed / 139968;
}
function show(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += b === 10 ? "|" : b === 0 ? "." : String.fromCharCode(b);
  return text;
}

const starts = [0, 3, -0, -2, 2.5, NaN, Infinity, -Infinity, 2 ** 48, 2 ** 48 + 2, 2 ** 53, 60];
for (const start of starts) {
  const output = new Uint8Array(40);
  const end = lines(input, output, 20, start);
  console.log("lines", start, end, show(output));
}
for (const count of [0, 1, 6, 7, 2.5, -3, NaN]) {
  const output = new Uint8Array(24);
  console.log("count", count, lines(input, output, count, 0), show(output));
}
for (const [line, i, o] of [
  [5, 0, 10],
  [5, -1, 4],
  [3.5, 2, 8],
  [NaN, 0, 5],
  [4, 0.5, 6],
  [4, 2 ** 48, 2 ** 48],
  [4, 1, -0],
] as const) {
  const output = new Uint8Array(12);
  console.log("reverse", line, i, o, reverse(input, output, line, i, o), show(output));
}
for (const [line, i, o] of [
  [10, 0, 0],
  [64, 5, -3],
  [3, 2 ** 48 - 1, 7],
  [8, 1.5, 0],
] as const) {
  console.log("find", line, i, o, find(input, line, i, o));
}
for (const [line, o] of [
  [4, 0],
  [4, 2],
  [2, NaN],
] as const) {
  const output = new Uint8Array(8);
  console.log("restart", line, o, restart(input, output, line, o), show(output));
}
for (const start of [0, 20, 40, 2.5]) {
  const output = new Uint8Array(64);
  try {
    console.log("guarded", start, guarded(input, output, 30, start), show(output));
  } catch (error) {
    console.log("guarded", start, error instanceof RangeError, (error as Error).message);
  }
}
