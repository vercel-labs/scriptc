// Escape-time loops in the shape of mandelbrot's rows: a short constant-count
// loop over pixel pairs whose inner loop exits once both pixels of the pair
// have escaped (`b |= 2`, `b |= 1`, `if (b === 3) break`). Pixels escape at
// different iterations or never; each byte packs the pairs' bits in order.
const LIMIT = 4;

function row(initial: Float64Array, ci: number, bytes: number, iterations: number): number[] {
  const out: number[] = [];
  for (let xByte = 0; xByte < bytes; xByte++) {
    let res = 0;
    for (let i = 0; i < 8; i += 2) {
      const x = xByte << 3;
      const cr1 = initial[x + i]!;
      const cr2 = initial[x + i + 1]!;
      let zr1 = cr1;
      let zi1 = ci;
      let zr2 = cr2;
      let zi2 = ci;
      let b = 0;
      for (let j = 0; j < iterations; j++) {
        const tr1 = zr1 * zr1;
        const ti1 = zi1 * zi1;
        zi1 = 2 * zr1 * zi1 + ci;
        zr1 = tr1 - ti1 + cr1;
        if (tr1 + ti1 > LIMIT) {
          b |= 2;
          if (b === 3) break;
        }
        const tr2 = zr2 * zr2;
        const ti2 = zi2 * zi2;
        zi2 = 2 * zr2 * zi2 + ci;
        zr2 = tr2 - ti2 + cr2;
        if (tr2 + ti2 > LIMIT) {
          b |= 1;
          if (b === 3) break;
        }
      }
      res = (res << 2) | b;
    }
    out.push(~res & 255);
  }
  return out;
}

/** Two pairs per value: the loop runs two iterations. */
function quads(initial: Float64Array, ci: number): number {
  let res = 0;
  for (let i = 0; i < 4; i += 2) {
    let zr1 = initial[i]!;
    let zr2 = initial[i + 1]!;
    let b = 0;
    for (let j = 0; j < 30; j++) {
      zr1 = zr1 * zr1 + ci;
      if (zr1 > 2) {
        b |= 2;
        if (b === 3) break;
      }
      zr2 = zr2 * zr2 + ci;
      if (zr2 > 2) {
        b |= 1;
        if (b === 3) break;
      }
    }
    res = res * 4 + b;
  }
  return res;
}

// Loops the jam keeps as they are. The inner loop clears the accumulator.
function resets(initial: Float64Array): number {
  let res = 0;
  for (let i = 0; i < 4; i += 2) {
    let zr1 = initial[i]!;
    let zr2 = initial[i + 1]!;
    let b = 0;
    for (let j = 0; j < 30; j++) {
      zr1 = zr1 * zr1 + 0.2;
      if (zr1 > 2) {
        b |= 2;
        if (b === 3) break;
      }
      zr2 = zr2 * zr2 + 0.2;
      if (zr2 > 2) {
        b |= 1;
        if (b === 3) break;
      }
      if (j > 20) b = 0;
    }
    res = res * 4 + b;
  }
  return res;
}

// The inner loop's body advances its counter.
function skips(initial: Float64Array): number {
  let res = 0;
  for (let i = 0; i < 4; i += 2) {
    let zr1 = initial[i]!;
    let zr2 = initial[i + 1]!;
    let b = 0;
    let steps = 0;
    for (let j = 0; j < 16; j++) {
      zr1 = zr1 * zr1 + 0.2;
      if (zr1 > 2) {
        b |= 2;
        if (b === 3) break;
      }
      zr2 = zr2 * zr2 + 0.2;
      if (zr2 > 2) {
        b |= 1;
        if (b === 3) break;
      }
      if (zr1 < 0.5) j = j + 1;
    }
    res = res * 4 + b;
  }
  return res;
}

// The inner loop's start and bound depend on the outer iteration.
function shifted(initial: Float64Array): number {
  let res = 0;
  for (let i = 0; i < 4; i += 2) {
    let zr1 = initial[i]!;
    let zr2 = initial[i + 1]!;
    let b = 0;
    const start = i * 3;
    for (let j = start; j < 10 + i; j++) {
      zr1 = zr1 * zr1 + 0.2;
      if (zr1 > 2) {
        b |= 2;
        if (b === 3) break;
      }
      zr2 = zr2 * zr2 + 0.2;
      if (zr2 > 2) {
        b |= 1;
        if (b === 3) break;
      }
    }
    res = res * 4 + b;
  }
  return res;
}

// The inner counter starts where `j++` leaves it unchanged or where its
// low bits never reach 3: the loop ends once both pixels escape.
function stuck(initial: Float64Array, start: number): number {
  let res = 0;
  for (let i = 0; i < 4; i += 2) {
    let zr1 = initial[i]!;
    let zr2 = initial[i + 1]!;
    let b = 0;
    for (let j = start; j < 40; j++) {
      zr1 = zr1 * zr1 + 0.2;
      if (zr1 > 2) {
        b |= 2;
        if (b === 3) break;
      }
      zr2 = zr2 * zr2 + 0.2;
      if (zr2 > 2) {
        b |= 1;
        if (b === 3) break;
      }
    }
    res = res * 4 + b;
  }
  return res;
}

const size = 64;
const initial = new Float64Array(size);
for (let x = 0; x < size; x++) initial[x] = (2 * x) / size - 1.5;
let checksum = 0;
const lines: string[] = [];
for (let y = 0; y < size; y += 8) {
  const ci = (2 * y) / size - 1;
  const bytes = row(initial, ci, size >> 3, y % 16 === 0 ? 50 : 3);
  lines.push(bytes.map((v) => v.toString(16).padStart(2, "0")).join(""));
  for (const v of bytes) checksum = (checksum * 31 + v) % 1000003;
}
console.log(lines.join("\n"));
console.log(checksum);
const q = new Float64Array([0.1, 1.5, -0.3, 3]);
console.log(quads(q, 0.2), quads(q, -1.9), quads(new Float64Array(4), 0));
// A row past the end of the coordinates reads NaN, which never escapes.
console.log(row(initial, 0.5, (size >> 3) + 1, 50).slice(-2));
const r = new Float64Array([1.2, 0.5, 1.3, 0.9]);
const s = new Float64Array([0.1, 0.1, 0.73, 0.74]);
console.log(resets(q), resets(r), skips(q), skips(s), shifted(q), shifted(r));
const e = new Float64Array([1.2, 1.5, 3, 0.9]);
console.log(stuck(e, -Infinity), stuck(e, -(2 ** 54)), stuck(e, 0.5), stuck(e, -7));
