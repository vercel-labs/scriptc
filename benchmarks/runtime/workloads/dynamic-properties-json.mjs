// Untyped JavaScript whose hot records are produced by JSON.parse: the same
// loop as dynamic-properties, over items and an origin that no declaration
// types, because the parser builds them at run time. Argument: the number of
// iterations.
const rounds = Number(process.argv[2] ?? "1000000");

function makeDocument(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    if (i % 3 === 0)
      items.push(
        `{"id":${i},"price":${i % 17},"qty":${i % 5},"meta":{"tag":${i % 7},"weight":${i % 11}}}`,
      );
    else
      items.push(
        `{"id":${i},"qty":${i % 5},"price":${i % 13},"meta":{"weight":${i % 9},"tag":${i % 5}}}`,
      );
  }
  return `{"items":[${items.join(",")}],"origin":{"x":0,"y":0}}`;
}

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

const doc = JSON.parse(makeDocument(1024));
const items = doc.items;
const origin = doc.origin;
const cursors = [];
for (let i = 0; i < 64; i++)
  cursors.push(i % 2 === 0 ? new Cursor(i - 32, 7 - i) : new Marker(i - 32, 7 - i, "m" + i));
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
