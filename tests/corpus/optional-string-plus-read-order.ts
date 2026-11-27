export {};
// An optional-string `+` reads its left operand before evaluating the right
// one. An unchecked array element keeps a runtime-undefined arm even when
// the checker narrowed the binding, so the lowering snapshots operands; it
// must not leave a left read in place after a right operand that writes
// what the left one reads.
const words: (string | undefined)[] = ["first"];
let local: string | undefined = words[0];
console.log(local + (local = "second"));
console.log(local);

const box: { text: string | undefined } = { text: "alpha" };
function rewrite(): string {
  box.text = "beta";
  return "!";
}
console.log(box.text + rewrite());
console.log(box.text);

function take(): (string | undefined)[] {
  return ["start"];
}
let picked: string | undefined = take()[0];
console.log(picked + (picked = "end"));
console.log(picked);
