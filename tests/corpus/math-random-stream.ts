// Math.random's values cannot be compared with Node's, so this pins what
// every conforming generator shows over many draws: each is a multiple of
// 2^-53 in [0, 1), draws do not repeat, every one of the 53 bits is both set
// and clear in some draw, the mean is near one half, and sixteen equal
// buckets fill evenly. The bounds are tens of standard deviations wide, so a
// correct generator fails them about never and a stuck, short-period or
// biased one fails them at once.
const draws = 200000;
const values = new Float64Array(draws);
for (let i = 0; i < draws; i++) values[i] = Math.random();

let inRange = true;
let onGrid = true;
let sum = 0;
const buckets: number[] = new Array<number>(16).fill(0);
const seen = new Set<number>();
// Each draw is k / 2^53: split k into a high part of 27 bits and a low part
// of 26, which are int32 values, and collect the bits seen set and clear.
let highSet = 0;
let highClear = 0;
let lowSet = 0;
let lowClear = 0;
for (let i = 0; i < draws; i++) {
  const r = values[i]!;
  if (!(r >= 0 && r < 1)) inRange = false;
  const k = r * 9007199254740992;
  if (!Number.isInteger(k)) onGrid = false;
  const high = Math.floor(k / 67108864);
  const low = k - high * 67108864;
  highSet |= high;
  highClear |= ~high & 0x7ffffff;
  lowSet |= low;
  lowClear |= ~low & 0x3ffffff;
  sum += r;
  buckets[Math.floor(r * 16)]! += 1;
  // Two equal draws among the first 20,000 have probability near 2^-25.
  if (i < 20000) seen.add(r);
}
console.log("in range", inRange);
console.log("multiples of 2^-53", onGrid);
console.log("every bit set somewhere", highSet === 0x7ffffff, lowSet === 0x3ffffff);
console.log("every bit clear somewhere", highClear === 0x7ffffff, lowClear === 0x3ffffff);
console.log("distinct", seen.size === 20000);
const mean = sum / draws;
console.log("mean near 0.5", mean > 0.48 && mean < 0.52);
// Expected 12,500 per bucket with a standard deviation near 108.
console.log("buckets even", buckets.every((n) => n > 11000 && n < 14000));

// Two runs of consecutive draws do not line up at any small lag: a generator
// that restarted or repeated its stream would.
const first = values.subarray(0, 1000);
let repeats = 0;
for (let lag = 1; lag <= 64; lag++) {
  let same = 0;
  for (let i = 0; i + lag < first.length; i++) if (first[i] === first[i + lag]) same++;
  if (same > 0) repeats++;
}
console.log("no repeats at lags 1..64", repeats === 0);
