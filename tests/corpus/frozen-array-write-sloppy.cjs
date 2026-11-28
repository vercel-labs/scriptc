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
// A discarded write of a heap value releases the value it would have
// stored (no leak on the ignored path).
const words = ["a", "b"];
Object.freeze(words);
attempt("word", () => {
  words[0] = "z".repeat(3);
});
const openWords = ["c", "d"];
openWords[0] = "e".repeat(2);
console.log(JSON.stringify(words), JSON.stringify(openWords));
const open = [1, 2, 3];
open[0] = 9;
console.log(JSON.stringify(open));
