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

// The hook joins the class value's property table; the class's other statics
// keep their module storage, and its private static field initializer runs in
// source order with the rest.
class WithStatics {
  static total = 2;
  static #hidden = 40;
  static sum() {
    return WithStatics.total + WithStatics.#hidden;
  }
  static [Symbol.hasInstance](value) {
    return value === WithStatics.sum();
  }
}
console.log("statics:", WithStatics.sum(), WithStatics.total, 42 instanceof WithStatics);

// Writes reach that same storage.
WithStatics.total = 5;
WithStatics.total++;
console.log("write:", WithStatics.total, WithStatics.sum(), 45 instanceof WithStatics);

// A catch binding reaches the hook with the thrown value, through the class
// name and through a binding that holds the class.
function caught() {
  try {
    throw 42;
  } catch (error) {
    return error instanceof Hooked;
  }
}
const Held = Hooked;
function caughtHeld() {
  try {
    throw 42;
  } catch (error) {
    return error instanceof Held;
  }
}
console.log("caught:", caught(), caughtHeld());

// A static whose name is computed defines the key it folds to, so it
// overrides an inherited static exactly like a spelled name does: the class
// value's table answers `m` on the derived class, and the base keeps its own.
class Named {
  static m() {
    return "named";
  }
  static [Symbol.hasInstance](value) {
    return value === "named";
  }
}
class Renamed extends Named {
  static ["m"]() {
    return "renamed";
  }
}
console.log("computed:", Renamed.m(), Named.m(), "named" instanceof Renamed);

// A class value held by a parameter answers the same call through its table.
function callStatic(C) {
  return C.m();
}
console.log("computed-param:", callStatic(Renamed), callStatic(Named));

// A static accessor keeps the class's statics in the same table, so a
// computed-name override still hides the inherited static.
class Tagged {
  static m() {
    return "tagged";
  }
  static get tag() {
    return 1;
  }
}
class Retagged extends Tagged {
  static ["m"]() {
    return "retagged";
  }
}
console.log("computed-accessor:", Retagged.m(), Tagged.m(), Retagged.tag);

// The override is inherited further down the chain.
class Deeper extends Renamed {}
console.log("computed-derived:", Deeper.m(), callStatic(Deeper));
