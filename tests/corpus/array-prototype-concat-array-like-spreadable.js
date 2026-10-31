// Array.prototype.concat over an array-like receiver: IsConcatSpreadable
// decides whether the receiver's elements spread, and a spreadable
// receiver's length is read through ToLength, so a length that throws does.
const attempt = (label, run) => {
  try {
    console.log(label, "no-throw", JSON.stringify(run()));
  } catch (error) {
    console.log(label, error.constructor.name, error.message);
  }
};

const spreadable = { 0: "a", 1: "b", length: 2 };
spreadable[Symbol.isConcatSpreadable] = true;
const plain = { 0: "a", 1: "b", length: 2 };
const falsy = { 0: "a", length: 1 };
falsy[Symbol.isConcatSpreadable] = 0;
const broken = { length: { valueOf: null, toString: null }, 1: "A", 3: "B", 5: "C" };
broken[Symbol.isConcatSpreadable] = true;
const sparse = { length: 3, 1: "m" };
sparse[Symbol.isConcatSpreadable] = true;

attempt("spreadable", () => Array.prototype.concat.call(spreadable, "x", ["y"]));
attempt("plain", () => Array.prototype.concat.call(plain, "x"));
attempt("falsy", () => Array.prototype.concat.call(falsy));
attempt("sparse", () => Array.prototype.concat.call(sparse));
attempt("nothing", () => Array.prototype.concat.call(spreadable));
attempt("broken", () => Array.prototype.concat.call(broken, "x"));
attempt("broken-tostring", () => {
  const value = { length: { valueOf: () => 1, toString: () => { throw new TypeError("length toString"); } } };
  value[Symbol.isConcatSpreadable] = true;
  return Array.prototype.concat.call(value);
});
