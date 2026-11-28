// A builtin Error's `stack` read lowers to a present string while the
// checker spells it `string | undefined`. Every step after the `?.` guard
// then runs on a present value, so its type loses the chain's nullish arm:
// the last call of `error.stack?.split("\n").slice(1).join("\n")` sees
// string[] and not `string[] | undefined`. A step that can answer
// undefined on its own keeps its own guard and is checked by comparing the
// same chain over a program's optional field.

const error = new Error("boom");
const frames = error.stack?.split("\n").slice(1).join("\n") ?? "";
console.log(typeof frames, frames.includes("    at ") || frames.includes("\tat "));

const object: { text?: string } = { text: "a\nb\nc" };
console.log(object.text?.split("\n").slice(1).join("|"));

const missing: { text?: string } = {};
console.log(missing.text?.split("\n").join("|") === undefined);

function make(): { text?: string } {
  return { text: "x\ny" };
}
console.log(make().text?.split("\n").join(","));

const numbers = [1, 2, 3];
console.log(numbers.find((value) => value > 1)?.toString());
console.log(numbers.at(-1)?.toString());
