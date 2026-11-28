// Same frozen array in sloppy code: Node answers false from [[Set]] and
// [[Delete]], so the write and the delete are ignored, while a mutating
// method still throws. Differentially vs Node.
function attempt(label, write) {
  try {
    write();
    console.log(`${label}: ok`);
  } catch (error) {
    console.log(`${label}: ${error.name}`);
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
