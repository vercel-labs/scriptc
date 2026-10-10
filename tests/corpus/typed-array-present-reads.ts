// Typed-array reads proven to name an element (a non-negative counter under
// an `i < t.length` guard, including the length of a same-length parallel
// array), and NaN-coded reads under a comparison that excludes undefined,
// are plain numbers. The neighbors those proofs must not cover still read
// undefined for an index outside [0, length), like Node.
const base: number = process.argv.length; // 2 under both runtimes
const nan = base / 0 - base / 0;

class Relation {
  private readonly regular: Int32Array;
  calls = 0;
  constructor(size: number) {
    this.regular = new Int32Array(size);
    for (let i = 0; i < size; i++) this.regular[i] = i % 3 === 0 ? -1 : size - i;
  }
  assignable(source: number, target: number): boolean {
    if (source === target) return true;
    this.calls++;
    return this.related(Number(source), Number(target)) !== 0;
  }
  private related(inputSource: number, inputTarget: number): number {
    if (inputSource === inputTarget) return 1;
    // Out of range or NaN: undefined, so the comparison picks the input.
    const regularSource = this.regular[inputSource];
    const regularTarget = this.regular[inputTarget];
    const sourceId = regularSource >= 0 ? regularSource : inputSource;
    const targetId = regularTarget >= 0 ? regularTarget : inputTarget;
    if (sourceId === targetId) return 1;
    return this.simple(sourceId, targetId) ? 1 : 0;
  }
  private simple(sourceId: number, targetId: number): boolean {
    return sourceId < targetId || sourceId !== sourceId || targetId !== targetId;
  }
}

interface Query {
  source: number;
  target: number;
}

function check(queries: Query[]): void {
  const relation = new Relation(8);
  const results: boolean[] = [];
  const sources = new Uint32Array(queries.length);
  const targets = new Uint32Array(queries.length);
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    sources[i] = query.source;
    targets[i] = query.target;
    results.push(relation.assignable(query.source, query.target));
  }
  let checksum = 0;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < sources.length; i++) {
      if (relation.assignable(sources[i], targets[i])) checksum++;
    }
  }
  console.log("results", results.join(","));
  console.log("checksum", checksum, "calls", relation.calls);
  const lanes: number[] = [];
  for (let i = 0; i < sources.length; i++) lanes.push(sources[i], targets[i]);
  console.log("lanes", lanes.join(","));
}

check([
  { source: 1, target: 1 },
  { source: 2, target: 5 },
  { source: 3, target: 0 },
  { source: 7, target: 4 },
  { source: nan, target: nan },
  { source: nan, target: 2 },
  { source: 12, target: 3 },
  { source: -1, target: 6 },
  { source: 2.5, target: 1 },
]);

function show(label: string, value: number): string {
  return `${label}=${typeof value}:${String(value)}`;
}

function equal(a: number, b: number): boolean {
  return a === b;
}

// Neighbors: every read below may name a missing element.
function neighbors(n: number): void {
  const long = new Uint16Array(n);
  const short = new Uint16Array(n - 1);
  for (let i = 0; i < n; i++) long[i] = 10 + i;
  for (let i = 0; i < n - 1; i++) short[i] = 20 + i;
  const out: string[] = [];
  // Inclusive bound: the last read is past the end.
  for (let i = 0; i <= long.length; i++) out.push(show("le" + i, long[i]));
  // A shorter parallel array is not bounded by the longer one's length.
  for (let i = 0; i < long.length; i++) out.push(show("par" + i, short[i]));
  // A counter that goes down reaches -1.
  for (let i = 1; i >= -1; i--) out.push(show("down" + i, long[i]));
  // A counter that a closure also writes.
  let k = 0;
  const skip = (): void => {
    k += 2;
  };
  for (; k < long.length; k++) {
    skip();
    out.push(show("skip" + k, long[k]));
  }
  // A fractional step is not an integer index.
  let f = 0;
  for (; f < long.length; f += 1.5) out.push(show("frac" + f, long[f]));
  console.log(out.join(" "));
  // Undefined equals undefined even through parameters.
  const missing = long[n + 3];
  const alsoMissing = short[n + 3];
  console.log("equal", equal(missing, alsoMissing), equal(long[0], long[0]), equal(missing, nan));
  // A guarded occurrence is a number; the unguarded one is still undefined.
  const regular = long[n + 1];
  const picked = regular >= 0 ? regular : -7;
  console.log("guard", picked, show("raw", regular), regular > 3 ? show("in", regular) : "none");
  let moved = long[0];
  if (moved >= 0) {
    moved = long[n + 5];
    console.log("moved", show("m", moved));
  }
}

neighbors(4);
neighbors(base);
