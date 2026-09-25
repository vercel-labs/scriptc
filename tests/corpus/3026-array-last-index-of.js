let trace = "";
function receiver() { trace += "r"; return [0, 1, 0]; }
function needle() { trace += "n"; return 0; }
function position() { trace += "p"; return "1.9"; }
console.log(receiver().lastIndexOf(needle(), position()), trace);
trace = "";
console.log(receiver().lastIndexOf(needle(), void position()), trace);

const numbers = [0, 1, 0, 1, 0];
/** @type {(number | string | boolean | null | undefined)[]} */
const positions = [undefined, null, false, true, "", "2.9", "bad", NaN, -Infinity, -3, -1, -0, 0, 1, 2, 4, Infinity, 99];
for (const value of positions) {
  console.log(numbers.lastIndexOf(0, value), numbers.lastIndexOf(1, value));
}
console.log(numbers.lastIndexOf(0), numbers.lastIndexOf(0, undefined));
console.log([NaN, 0, -0, NaN].lastIndexOf(NaN), [NaN, 0, -0].lastIndexOf(0));
console.log([undefined].lastIndexOf(undefined), [null, undefined].lastIndexOf(null));

const sparse = [1, , undefined, 1];
console.log(sparse.lastIndexOf(undefined), sparse.lastIndexOf(undefined, 1), sparse.lastIndexOf(1, 2));
