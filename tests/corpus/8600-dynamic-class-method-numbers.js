// Untyped code calls methods of compiled classes with numbers: overrides,
// `super` calls, static methods, missing and extra arguments, `arguments`,
// methods taken as values, numeric results and throws.
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
  scaled(k) {
    return this.x * k + this.y * k;
  }
  shift(dx, dy = dx * 2) {
    return this.x + dx + dy;
  }
  count() {
    return arguments.length + ":" + (arguments[0] ?? "none");
  }
  checked(v) {
    if (v > 50) throw new RangeError("step too large: " + v);
    return v / 2;
  }
  static mid(a, b) {
    return (a + b) / 2;
  }
}
class Fast extends Cursor {
  step(dx, dy) {
    super.step(dx * 2, dy * 2);
    return this;
  }
  scaled(k) {
    return super.scaled(k) + 0.25;
  }
}
const cursors = [new Cursor(1.5, -2.5), new Fast(0.5, 0.25), new Cursor(1e10, -1e10)];
let total = 0;
for (let r = 0; r < 300; r++) {
  const c = cursors[r % 3];
  c.step((r % 7) * 0.5 - 1, (r % 5) * 1.25 - 2);
  total += c.scaled(r % 4 === 0 ? 1.5 : 0.75);
  total += c.shift(r * 0.1);
  if (Math.abs(c.x) > 1e6 && c.x < 1e9) c.x = 0;
}
console.log(total.toFixed(4));
for (const c of cursors) console.log(c.constructor.name, c.x, c.y);
console.log(cursors[0].shift(1.5), cursors[0].shift(1.5, 0.5), cursors[1].shift(-0));
console.log(cursors[0].count(), cursors[0].count(2.5, 3), cursors[1].count(undefined));
console.log(Cursor.mid(1.5, 2), Cursor.mid(-0, 0), Fast.mid(2 ** 53, 1));
const fast = new Fast(0.5, 0.25);
const step = fast.step;
console.log(step.call(new Cursor(10.5, 20.5), 1, 2).x, typeof step);
let caught = 0;
for (let i = 45; i < 55; i++) {
  try {
    total += cursors[0].checked(i * 1.25);
  } catch (e) {
    if (caught++ === 0) console.log(e instanceof RangeError, e.message);
  }
}
console.log(caught, total.toFixed(4));
console.log(cursors[0].scaled(NaN), cursors[1].scaled(Infinity), Object.is(cursors[0].scaled(-0) * 0, 0));
