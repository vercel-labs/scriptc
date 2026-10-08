// Arrays past 2^20 elements: filled, appended, forward- and backward-written
// arrays stay linear-time while holes, lengths and genuinely sparse indices
// keep JavaScript semantics. Completing quickly is part of the signal: these
// sizes previously routed every write through a sorted side store.
const n = 1_200_000;

function census(values: readonly number[]): string {
  let count = 0;
  let sum = 0;
  values.forEach((value) => {
    count++;
    sum += value;
  });
  return `${values.length}:${count}:${sum}`;
}

const counts: number[] = new Array<number>(n).fill(0);
for (let i = 0; i < n; i++) counts[i] = counts[i]! + (i % 3);
for (let i = n - 1; i >= 0; i -= 7) counts[i] = counts[i]! * 2;
console.log("fill", census(counts), counts[n - 1], counts[1_048_576]);

const sieveLimit = 1_300_000;
const prime: boolean[] = new Array<boolean>(sieveLimit + 1).fill(true);
prime[0] = false;
prime[1] = false;
for (let p = 2; p * p <= sieveLimit; p++) {
  if (prime[p]) for (let j = p * p; j <= sieveLimit; j += p) prime[j] = false;
}
let primes = 0;
let largest = 0;
for (let i = 0; i <= sieveLimit; i++) {
  if (prime[i]) {
    primes++;
    largest = i;
  }
}
console.log("sieve", primes, largest);

const pushed: number[] = [];
for (let i = 0; i < n; i++) pushed.push(i & 15);
pushed.unshift(-1, -2);
const tail = pushed.slice(n - 3);
const removed = pushed.splice(1_048_570, 10, 7, 7);
const joined = pushed.concat(tail);
pushed.fill(3, 1_100_000, 1_100_010);
console.log("bulk", census(pushed), tail.join(","), removed.join(","), census(joined));

const forward: number[] = new Array<number>(n);
for (let i = 0; i < n; i += 2) forward[i] = 1;
forward[n + 10] = 5;
console.log("forward", census(forward), forward.indexOf(5), forward.lastIndexOf(1));

const shortLength = 1_100_000;
const backward: number[] = new Array<number>(shortLength);
for (let i = shortLength - 1; i >= 1_000_000; i -= 2) backward[i] = i % 5;
console.log("backward", census(backward), backward.indexOf(4), backward.lastIndexOf(0));

const steps = 1_500_000;
const dp: number[] = new Array<number>(steps + 1);
dp[steps] = 0;
for (let i = steps - 1; i >= 0; i--) dp[i] = (dp[i + 1]! + i) % 1_000_003;
console.log("dp", census(dp), dp[0], dp[1_048_576]);

const sparse: number[] = [];
for (let k = 0; k < 2000; k++) sparse[k * 1_009 + 5] = k;
for (let round = 0; round < 3; round++) {
  for (let k = 0; k < 2000; k++) sparse[k * 1_009 + 5] = sparse[k * 1_009 + 5]! + 1;
}
console.log("search", sparse.length, sparse.indexOf(2002), sparse.indexOf(3), sparse.indexOf(-1));
sparse[4_294_967_294] = -1;
console.log("sparse", sparse.length, sparse[1_014], sparse[2_016_996], sparse[4_294_967_294]);
sparse.length = 1_500_000;
console.log("truncate", census(sparse), sparse.slice(1_400_000).length);

const words: string[] = new Array<string>(n).fill("a");
for (let i = 0; i < n; i += 4) words[i] = "bc";
let chars = 0;
for (const word of words) chars += word.length;
console.log("strings", chars, words.slice(n - 5).join("|"));
