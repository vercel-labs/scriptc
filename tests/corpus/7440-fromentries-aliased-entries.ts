// `Object.fromEntries(...) as T` over entries whose values are native
// arrays keeps their identity: both fields hold the one array the entries
// name, so a push through one is seen through the other and the original
// (corpus 6467 covers the scalar and checked-dynamic cases).
type Scores = { a: number[]; b: number[] };
const shared = [10];
const scores = Object.fromEntries([
  ["a", shared],
  ["b", shared],
]) as Scores;
scores.a.push(11);
console.log(shared.length, scores.b.length);
