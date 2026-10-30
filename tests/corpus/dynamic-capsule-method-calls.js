// Untyped code calls methods of compiled class instances: methods that
// return their receiver, numbers, strings or nothing, inherited and
// overriding methods, an instance whose own property shadows a method,
// receivers of mixed kinds at one site, argument evaluation order, missing
// and extra arguments, and throws from the called method.
class Cursor {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  step(dx, dy) {
    this.x += dx;
    this.y += dy;
    return this;
  }
  sum(k) {
    return (this.x + this.y) * k;
  }
  label(prefix) {
    return prefix + "(" + this.x + "," + this.y + ")";
  }
  reset() {
    this.x = 0;
    this.y = 0;
  }
  checked(v) {
    if (v > 40) throw new RangeError("too large: " + v);
    return v * 2;
  }
}
class Marker extends Cursor {
  constructor(x, y, name) {
    super(x, y);
    this.name = name;
  }
  label(prefix) {
    return "[" + this.name + "] " + super.label(prefix);
  }
}
class Fast extends Cursor {
  step(dx, dy) {
    this.x += dx * 2;
    this.y += dy * 2;
    return this;
  }
}

const order = [];
function note(tag, value) {
  order.push(tag);
  return value;
}

function drive(list, rounds) {
  let total = 0;
  let text = "";
  for (let r = 0; r < rounds; r++) {
    const c = list[r % list.length];
    const moved = c.step((r % 3) - 1, (r % 5) - 2);
    total += moved === c ? 1 : 1000;
    total += c.sum(r % 4);
    if (r % 50 === 0) text += c.label("r" + r) + ";";
    if (Math.abs(c.x) > 60) c.reset();
  }
  return total + " " + text;
}

const cursors = [];
for (let i = 0; i < 6; i++) {
  if (i % 3 === 0) cursors.push(new Cursor(i, -i));
  else if (i % 3 === 1) cursors.push(new Marker(i, i * 2, "m" + i));
  else cursors.push(new Fast(-i, i));
}
console.log(drive(cursors, 400));

// Instances built by one expression for both classes.
const mixed = [];
for (let i = 0; i < 4; i++) mixed.push(i % 2 === 0 ? new Cursor(i, i) : new Marker(i, -i, "t" + i));
console.log(drive(mixed, 200));
console.log(mixed.map((c) => c.label("m")).join(" "));

// The same site sees object literals and a shadowing own property.
const literal = {
  x: 1,
  y: 2,
  step(dx, dy) {
    this.x -= dx;
    this.y -= dy;
    return this;
  },
  sum(k) {
    return k;
  },
  label(prefix) {
    return prefix + "!";
  },
  reset() {},
};
const shadowed = new Cursor(5, 5);
shadowed.sum = function (k) {
  return -k;
};
console.log(drive([cursors[0], literal, shadowed, cursors[1]], 120));

// Chained calls and results used as values.
let chain = new Marker(1, 1, "chain");
for (let i = 0; i < 20; i++) chain = chain.step(1, 2).step(-0.5, 0.25);
console.log(chain.x, chain.y, chain.name, chain.label("end"));

// Arguments are evaluated after the receiver, left to right.
const target = new Cursor(0, 0);
for (let i = 0; i < 3; i++) note("recv" + i, target).step(note("a" + i, 1), note("b" + i, 2));
console.log(order.join(","), target.x, target.y);

// Missing and extra arguments.
const loose = new Fast(1, 1);
for (let i = 0; i < 3; i++) {
  loose.step(1);
  loose.step(1, 2, 3);
}
console.log(loose.x, Number.isNaN(loose.y), cursors[2].sum(), cursors[3].reset());

// A throw from the called method unwinds to the caller's handler.
let caught = 0;
let doubled = 0;
for (let i = 35; i < 45; i++) {
  try {
    doubled += cursors[i % 2].checked(i);
  } catch (e) {
    if (caught++ === 0) console.log(e instanceof RangeError, e.message);
  }
}
console.log(caught, doubled);
