// `instanceof` asks a class's static `Symbol.hasInstance` hook first and only
// without one walks the prototype chain (OrdinaryHasInstance). The hook is
// inherited through the static prototype chain and is an ordinary static
// member, so every shape that reaches the class value must consult it.
'use strict';

class Hooked {
  static [Symbol.hasInstance](value) {
    return value === 42 || value === Hooked;
  }
}
console.log("direct:", 42 instanceof Hooked, 41 instanceof Hooked, Hooked instanceof Hooked);

class Plain {}
console.log("plain:", new Plain() instanceof Plain, 1 instanceof Plain);

// A dyn parameter reaches the same hook.
function test(C, value) {
  return value instanceof C;
}
console.log("param:", test(Hooked, 42), test(Hooked, 43), test(Plain, new Plain()));

// The loop over a class-constructor array reaches it too.
for (const C of [Hooked, Plain]) {
  console.log("loop:", C.name, 42 instanceof C);
}

// A derived class inherits the hook through the static prototype chain.
class Derived extends Hooked {}
console.log("derived:", 42 instanceof Derived, new Plain() instanceof Derived);

// The hook is an ordinary static property.
console.log("member:", typeof Hooked[Symbol.hasInstance], Hooked[Symbol.hasInstance](42));
