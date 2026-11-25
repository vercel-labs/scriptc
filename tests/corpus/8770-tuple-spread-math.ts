// A fixed number tuple spreads into Math.max/Math.min as its positions.
const triplet: [number, number, number] = [3, 7, 5];
console.log(Math.max(...triplet), Math.min(...triplet));

function make(): [number, number, number] {
  return [1, -2, 4];
}
console.log(Math.max(...make()), Math.min(...make()));

const pair: [number, number] = [NaN, 1];
console.log(Math.max(...pair), Math.min(...pair));

const signed: [number, number] = [-0, 0];
console.log(Math.max(...signed), 1 / Math.max(...signed));
console.log(Math.min(...signed), 1 / Math.min(...signed));

const single: [number] = [42];
console.log(Math.max(...single), Math.min(...single));

// The receiver is evaluated once: Node reads the tuple's own array once.
let calls = 0;
function noisy(): [number, number, number] {
  calls += 1;
  console.log("evaluated");
  return [9, 1, 4];
}
console.log(Math.max(...noisy()), calls);

// A plain number[] keeps the array fold.
const list = [2, 9, 1];
console.log(Math.max(...list), Math.min(...list));
