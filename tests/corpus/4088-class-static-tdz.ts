// @exit: 1
// A class expression's static initializer runs where the class is
// evaluated: reading a later binding through a hoisted function throws.
console.log("before");
const Tagged = class {
  static label = describe();
  name = "tag";
};
function describe(): string {
  return prefix + "!";
}
const prefix = "item";
console.log(Tagged.label);
