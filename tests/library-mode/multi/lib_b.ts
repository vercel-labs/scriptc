// Multi-instance fixture, instance B (prefix mb_): allocation-heavy work the
// probe drives concurrently with instance A from B's dedicated thread. Every
// call builds and folds a fresh array, so B's allocator and collector churn
// while A runs (and traps) — independence shows up as B's answers staying
// exact throughout.
let total = 0;

export function sumTo(n: number): number {
  const xs: number[] = [];
  for (let i = 1; i <= n; i++) xs.push(i);
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function add(x: number): number {
  total += x;
  return total;
}

console.log("multi-b ready");
