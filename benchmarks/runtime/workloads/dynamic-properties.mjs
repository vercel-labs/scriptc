// Untyped JavaScript reading and writing properties of values it never
// declares types for: records built by object literals in two key orders,
// nested records, property updates, and instances of a class and its
// subclass read and written the same way. Argument: the number of
// iterations.
const rounds = Number(process.argv[2] ?? "1000000");
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
}
class Marker extends Cursor {
  constructor(x, y, label) {
    super(x, y);
    this.label = label;
  }
}
function makeItem(i) {
  if (i % 3 === 0)
    return { id: i, price: i % 17, qty: i % 5, meta: { tag: i % 7, weight: i % 11 } };
  return { id: i, qty: i % 5, price: i % 13, meta: { weight: i % 9, tag: i % 5 } };
}
function cost(item) {
  return item.price * item.qty + item.meta.weight;
}
function restock(item, round) {
  item.qty = (item.qty + round) % 7;
  item.meta.tag = (item.meta.tag + 1) % 7;
}
function distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
const items = [];
for (let i = 0; i < 1024; i++) items.push(makeItem(i));
const cursors = [];
for (let i = 0; i < 64; i++)
  cursors.push(i % 2 === 0 ? new Cursor(i - 32, 7 - i) : new Marker(i - 32, 7 - i, "m" + i));
const origin = { x: 0, y: 0 };
let checksum = 0;
for (let r = 0; r < rounds; r++) {
  const item = items[r & 1023];
  checksum += cost(item);
  restock(item, r & 3);
  checksum += item.meta.tag;
  const cursor = cursors[r & 63];
  checksum += distance(cursor.step((r % 3) - 1, (r % 5) - 2), origin);
  if (cursor.x > 100 || cursor.x < -100) cursor.x = 0;
  if (cursor.y > 100 || cursor.y < -100) cursor.y = 0;
}
console.log(checksum, items[5].qty, items[6].meta.tag, cursors[3].x, cursors[3].y, cursors[3].label);
