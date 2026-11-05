// Two dynamic slots of one declared type: the operations in the loop are
// on `hot`, and `cold` is read once.
type Hook = (() => number) | AbortSignal | Map<string, (x: number) => string>;

let cold: Hook = () => 1;
let hot: Hook = () => 2;

function run(rounds: number): number {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    if (typeof hot === "function") total += hot();
  }
  return total;
}

console.log(run(10), typeof cold);
