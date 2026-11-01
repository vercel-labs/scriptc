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
// A missing index is not created on the result: concat creates a property only
// where HasProperty holds, so the hole stays absent and the methods that skip
// holes skip it too.
attempt("sparse-shape", () => {
  const result = Array.prototype.concat.call(sparse, "z");
  return [result.length, 0 in result, 1 in result, 2 in result, 3 in result, Object.keys(result)];
});
attempt("sparse-map", () => Array.prototype.concat.call(sparse).map((value, index) => `${index}:${value}`));
attempt("sparse-filter", () => Array.prototype.concat.call(sparse).filter(() => true));
// A Proxy receiver answers @@isConcatSpreadable through the handler's get
// trap, which receives the symbol as the property key; the target answers
// when the handler has no get trap.
const trapped = [];
const proxyTarget = { length: 2, 0: "p", 1: "q" };
const plainProxy = new Proxy(proxyTarget, {
  get(object, key) {
    trapped.push(typeof key === "symbol" ? "symbol" : String(key));
    return object[key];
  },
});
attempt("proxy", () => {
  const result = Array.prototype.concat.call(plainProxy, "r");
  return [result.length, result[0] === plainProxy, trapped.join(",")];
});
const spreadTarget = { length: 2, 0: "p", 1: "q" };
spreadTarget[Symbol.isConcatSpreadable] = true;
const spreadProxy = new Proxy(spreadTarget, {
  get(object, key) {
    trapped.push(typeof key === "symbol" ? "symbol" : String(key));
    return object[key];
  },
});
attempt("proxy-spread", () => {
  const result = Array.prototype.concat.call(spreadProxy, "r");
  return [result.length, result.join(""), trapped.join(",")];
});
attempt("nothing", () => Array.prototype.concat.call(spreadable));
attempt("broken", () => Array.prototype.concat.call(broken, "x"));
attempt("broken-tostring", () => {
  const value = { length: { valueOf: () => 1, toString: () => { throw new TypeError("length toString"); } } };
  value[Symbol.isConcatSpreadable] = true;
  return Array.prototype.concat.call(value);
});
