// `??` over class values whose assertion or default changes the class:
// `(x as Sub | undefined) ?? fallback` checks the stored class before the
// subclass view is used, a subclass value defaulted to a base-class value
// upcasts, and `(x ?? y) as Sub` asserts the coalesced value.

class Shape {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
  area(): number {
    return 0;
  }
}

class Circle extends Shape {
  radius: number;
  linked: Shape | undefined = undefined;
  constructor(id: number, radius: number) {
    super(id);
    this.radius = radius;
  }
  area(): number {
    return 3 * this.radius * this.radius;
  }
}

class Square extends Shape {
  side = 2;
  area(): number {
    return this.side * this.side;
  }
}

function linkedCircle(c: Circle): Circle {
  const target = (c.linked as Circle | undefined) ?? c;
  return target;
}

const first = new Circle(1, 1);
const second = new Circle(2, 3);
console.log(linkedCircle(first).id, linkedCircle(first).radius);
first.linked = second;
console.log(linkedCircle(first).id, linkedCircle(first).radius);

const viaCast = first.linked as Circle | undefined;
console.log(viaCast?.radius, (second.linked as Circle | undefined)?.radius);

// A subclass value defaulted to a base-class value.
let current: Circle | undefined = undefined;
function shapeOrDefault(fallback: Shape): Shape {
  return current ?? fallback;
}
console.log(shapeOrDefault(new Square(7)).area());
current = second;
console.log(shapeOrDefault(new Square(7)).area());

const byName = new Map<string, Circle>();
byName.set("c", first);
const found: Shape = byName.get("c") ?? new Shape(0);
const missing: Shape = byName.get("x") ?? new Shape(0);
console.log(found.id, found.area(), missing.id, missing.area());

// The default may also be a sibling class or a primitive.
const either = (second.linked as Circle | undefined) ?? new Square(4);
console.log(either.id, either.area());
const counted = (second.linked as Circle | undefined) ?? 5;
console.log(typeof counted);

// Asserting the coalesced value.
const coalesced = (second.linked ?? second) as Circle;
console.log(coalesced.id, coalesced.radius);

// The right side stays lazy.
let calls = 0;
function makeShape(): Shape {
  calls++;
  return new Shape(9);
}
const lazy: Shape = (first.linked as Circle | undefined) ?? makeShape();
console.log(lazy.id, calls);
