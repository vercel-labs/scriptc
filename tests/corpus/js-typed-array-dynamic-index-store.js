// A typed-array element store whose index is checked-dynamic (an untyped
// parameter, as in three's computeTangents `used[a] = 1`) writes through the
// checked-dynamic property store: Node's integer-indexed exotic write coerces
// the value and ignores an index outside the view, as it does for the
// statement form of the same store.

function mark(buffer, key, value) {
  buffer[key] = value;
}

const used = new Uint8Array(4);
mark(used, 0, 1);
mark(used, "2", 4.7);
mark(used, -1, 9);
mark(used, 3.5, 9);
mark(used, 9, 9);
console.log("used", Array.from(used).join(","), used.length);

function chain(buffer, a, b) {
  return (buffer[a] = buffer[b] = 7);
}

const flags = new Uint8Array(3);
console.log("chain", chain(flags, 1, 2), Array.from(flags).join(","));

function read(buffer, key) {
  return buffer[key];
}
console.log("read", read(flags, 0), read(flags, 1), read(flags, 42));
