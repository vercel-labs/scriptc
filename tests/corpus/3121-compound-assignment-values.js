let count = 1;
console.log(count += 2, count *= 3, count);

function mutate() {
  count = 20;
  return 4;
}

console.log(count += mutate(), count);

let label = "a";
console.log(label += "b", label);

function update() {
  return count += 5;
}

console.log(update(), count);

let first, second;
async function main() {
  for await ([first = count += 1, second = count *= 2] of [[]]) {
    console.log(first, second, count);
  }
}
void main();
