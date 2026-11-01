// `instanceof` with a class value that is not statically known: a for-of
// over an array of class constructors (<[A, B, D]>) types every iteration's
// loop variable with the array's best common type, but the slot holds a
// different constructor each time. The right-hand side of `instanceof` must
// dispatch on the class the value actually IS, so `new C() instanceof C`
// holds for every iteration, a subclass instance is also an instance of its
// base, and an unrelated class is not. The checker's named type must not be
// used as the answer for the second and later elements.
// @ts-nocheck -- the array literal's inferred element type names the first
// class, so the typed program would narrow `C` to `typeof A`; the point of
// this program is the untyped class value each iteration really holds.
function describe(value) {
  if (value instanceof TypeError) return "TypeError: " + value.message;
  return String(value);
}

class A {
  constructor() {
    this.kind = "A";
  }
}
class B {
  constructor() {
    this.kind = "B";
  }
}
class D extends B {
  constructor() {
    super();
    this.kind = "D";
  }
}
class M extends Date {}

function isInstance(instance, classValue) {
  return instance instanceof classValue;
}

for (const C of [A, B, D]) {
  const made = new C();
  console.log(made.kind, made instanceof C);
  console.log("A", isInstance(made, A), "B", isInstance(made, B), "D", isInstance(made, D));
  console.log("param", isInstance(made, C));
  console.log("primitive", 42 instanceof C);
}

for (const C of [M]) {
  const stamp = new C(0);
  console.log("date subclass", stamp instanceof C, stamp instanceof M, stamp instanceof Date);
  console.log("date foreign", new Date(0) instanceof C);
}

try {
  for (const C of [A, B]) {
    throw new C();
  }
} catch (error) {
  console.log("thrown", describe(error), error instanceof B, error instanceof A);
}
