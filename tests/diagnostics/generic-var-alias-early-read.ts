// A module-scope `var` alias of a generic function, used before its
// declaration runs. JavaScript hoists the alias as `undefined`, so a call
// evaluates its arguments and then throws "is not a function" — the call
// below compiles to exactly that (tests/corpus/generic-erased-value-tdz.ts
// checks the output against Node). A read that HANDS THE VALUE OUT has no
// function to hand out, though, so it is refused by name.
function identity<T>(x: T): T {
  return x;
}

// The arguments run, then the call throws: JavaScript finds `undefined`.
function callEarly(): number {
  return varAlias(3);
}

// Handing the early value out cannot compile: JavaScript reads `undefined`.
function readEarly(): unknown {
  return varAlias;
}

var varAlias = identity;
console.log("late", callEarly, readEarly, typeof varAlias);
