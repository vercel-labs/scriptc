// A function that takes a rest parameter, stored where a zero-argument
// callback type is expected. A call through the slot passes no arguments;
// the array methods that receive its type pass the element, the index and
// the array, and the stored function observes all three.
const f = (...args: unknown[]) => {
  console.log("f", args.length, args.map(String).join("|"));
};
const g: () => void = f;
g();
[10, 20].forEach(g);
["a", "b", "c"].forEach(g);
