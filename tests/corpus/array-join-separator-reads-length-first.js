// Array.prototype.join reads the length before it converts the separator:
// a separator whose toString changes the array joins exactly that many
// elements, and elements it removed join as empty strings. Object literal,
// class instance and untyped separators.
function joinChanging(change) {
  const values = ["a", "b", "c"];
  const sep = {
    toString() {
      change(values);
      return "-";
    },
  };
  return values.join(sep);
}
console.log(joinChanging((values) => { values.push("d"); }));
console.log(joinChanging((values) => { values.length = 1; }));
console.log(joinChanging((values) => { values.length = 0; }));
console.log(joinChanging((values) => { values[1] = "B"; }));
console.log(joinChanging(() => {}));
class Sep {
  constructor(values) { this.values = values; }
  toString() { this.values.length = 2; return "+"; }
}
const shrinking = ["x", "y", "z"];
console.log(shrinking.join(new Sep(shrinking)));
function untyped(values, sep) { return values.join(sep); }
const grow = ["p", "q"];
console.log(untyped(grow, { toString() { grow.push("r"); return "/"; } }));
