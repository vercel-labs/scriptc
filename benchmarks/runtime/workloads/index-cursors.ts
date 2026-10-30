// Arrays of indices walked by loop-carried cursors: each step reads the
// next index from the array and relinks the visited entries, so the
// cursor and every stored value are small integers read back from the
// array itself.
const N = 4096;

function relink(rounds: number): number {
  const next: number[] = [];
  for (let i = 0; i < N; i++) next.push(i + 1 < N ? i + 1 : 0);
  let at = next[0]!;
  let total = 0;
  for (let r = 0; r < rounds; r++) {
    for (let s = 0; s < N; s++) {
      const t = next[at]!;
      next[at] = next[t]!;
      next[t] = at;
      at = t;
      total = (total + at) | 0;
    }
  }
  return total;
}

const rounds = Number(process.argv[2] ?? "1");
console.log("relink", relink(rounds));
