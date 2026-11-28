// Element writes on a frozen array throw TypeError in strict code and the
// array keeps its elements; a mutating method throws in either mode.
// Differentially vs Node.
function attempt(label: string, write: () => void): void {
  try {
    write();
    console.log(`${label}: ok`);
  } catch (error) {
    console.log(`${label}: ${(error as Error).name}`);
  }
}
const numbers = [1, 2, 3];
Object.freeze(numbers);
attempt("write", () => {
  numbers[0] = 9;
});
attempt("push", () => {
  numbers.push(4);
});
attempt("length", () => {
  numbers.length = 1;
});
console.log(JSON.stringify(numbers), numbers.length);
const open = [1, 2, 3];
open[0] = 9;
console.log(JSON.stringify(open));
