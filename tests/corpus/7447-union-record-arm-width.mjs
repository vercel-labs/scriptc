// Values read back from arrays whose elements mix object literals of
// different widths, an empty object among them, keep every field: the
// record arm with more fields is tried before `{}`, which matches every
// object.
const pairs = [
  ["a", { publicKeyEncoding: 5 }],
  ["b", {}],
  ["c", { publicKeyEncoding: 6, extra: true }],
];
for (const [label, value] of pairs) console.log(label, Object.keys(value), JSON.stringify(value));

const options = [
  ["rsa", { modulusLength: 1024 }],
  ["ec", { namedCurve: "P-256", paramEncoding: "named" }],
  ["none", {}],
];
for (const [type, value] of options) {
  const { modulusLength, namedCurve, paramEncoding } = value;
  console.log(type, modulusLength, namedCurve, paramEncoding);
}

const mixed = [{ a: 1 }, {}, "s", { a: 2, b: "two" }];
for (const value of mixed) {
  console.log(typeof value, JSON.stringify(value), typeof value === "object" ? Object.keys(value).length : -1);
}

function describe(value) {
  return Object.entries(value)
    .map(([key, field]) => `${key}=${field}`)
    .join(";");
}
const rows = [
  [1, { x: 1, y: 2 }],
  [2, {}],
  [3, { x: 3 }],
];
for (const [id, value] of rows) console.log(id, describe(value), value.x, value.y);
