const words: string[] = [];
words[1] = "x";

const leftMissing = words[0] + 1;
const rightMissing = 1 + words[0];
const bothMissing = words[0] + words[2];
const present = words[1] + 1;
console.log("stored", typeof leftMissing, leftMissing, typeof rightMissing, rightMissing);
console.log("pairs", typeof bothMissing, bothMissing, typeof present, present);

function compute(index: number): string {
  return words[index] + 1;
}
const missingCall = compute(4);
const presentCall = compute(1);
console.log("calls", typeof missingCall, missingCall, typeof presentCall, presentCall);

let calls = 0;
function next(): string[] {
  calls++;
  return words;
}
console.log("effects", next()[0] + next()[1], calls);
