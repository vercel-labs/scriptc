// A named function expression's name is a binding inside the function, and
// the binding holds the function object itself. The body's own reads take
// the running closure; a nested function reaches the same value through a
// copy it captures, so both spellings answer the one function.

const make = function self() {
  return () => self;
};
const first = make();
const second = make();
console.log("identity", first() === second(), first() === make, second() === make);

// The serialize-javascript shape: a nested function declaration recurses
// through the enclosing function expression's name.
const factorial = function fact(n) {
  function step(k) {
    return k <= 1 ? 1 : k * fact(k - 1);
  }
  return step(n);
};
console.log("nested-declaration", factorial(6), factorial(0));

// A local arrow shadows the name inside its own scope.
const shadowed = function outer() {
  return () => {
    const outer = "inner";
    return outer;
  };
};
console.log("shadowed", shadowed()());

// `typeof` and the direct self read still describe the same function.
const probed = function thing() {
  const kinds = () => [typeof thing, thing.length];
  return kinds();
};
console.log("probed", probed().join(" "));

// A closure built before the call and invoked later keeps the binding.
const later = function retained() {
  return { at: () => retained.name };
};
console.log("later", later().at());
