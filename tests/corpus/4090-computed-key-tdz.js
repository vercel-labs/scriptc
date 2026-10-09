// @exit: 1
// A computed method key evaluates with its object literal, before the
// binding it names is initialized.
console.log("before");
const shelf = {
  [Keys.first]() {
    return "first";
  },
};
const Keys = { first: "opening" };
console.log(Object.keys(shelf));
