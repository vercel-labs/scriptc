// querystring.stringify reads each value as Node's lib/querystring.js does:
// obj[k] for every ObjectKeys name, an array's length once, and each element
// as the loop reaches it. A custom encoder runs between those reads.
import qs from "node:querystring";

// An array's named properties serialize their own values; holes and keys
// deleted after ObjectKeys serialize as empty values.
function tag(target, key, value) {
  target[key] = value;
  return target;
}
const named = tag(JSON.parse('["a","b"]'), "extra", "x");
console.log(
  "named",
  qs.stringify(named),
  qs.stringify(named, null, null, { encodeURIComponent: (s) => s.toUpperCase() }),
);
const holes = JSON.parse("[1,2,3]");
delete holes[1];
console.log(
  "holes",
  qs.stringify(holes),
  qs.stringify({ list: holes }),
  qs.stringify({ list: holes }, null, null, { encodeURIComponent: (s) => s.toUpperCase() }),
);

// An encoder that grows or shrinks the array being serialized.
const grow = JSON.parse('{"k":["a","b"]}');
const calls = [];
console.log(
  "grow",
  qs.stringify(grow, null, null, {
    encodeURIComponent: (s) => {
      calls.push(s);
      if (s === "a") grow.k.push("c");
      if (s === "b") grow.k.splice(1);
      return s;
    },
  }),
  JSON.stringify(calls),
  grow.k.length,
);
const shrink = JSON.parse('{"k":["a","b","c"],"n":"z"}');
console.log(
  "shrink",
  qs.stringify(shrink, null, null, {
    encodeURIComponent: (s) => {
      if (s === "a") shrink.k.splice(1);
      return s;
    },
  }),
);

// An encoder that replaces or deletes properties while it encodes a key:
// the value read before the call is the one serialized, and a later key
// that is gone serializes as an empty value.
const replaced = JSON.parse('{"k":["one","two"],"m":"kept","j":"w"}');
console.log(
  "replace",
  qs.stringify(replaced, null, null, {
    encodeURIComponent: (s) => {
      if (s === "k") replaced.k = "replaced " + s.repeat(40);
      if (s === "m") {
        delete replaced.m;
        delete replaced.j;
      }
      return s;
    },
  }),
  JSON.stringify(replaced),
);
const single = JSON.parse('{"k":"value"}');
console.log(
  "replace single",
  qs.stringify(single, null, null, {
    encodeURIComponent: (s) => {
      if (s === "k") single.k = { other: s.repeat(40) };
      return s;
    },
  }),
);

// Values that are not objects serialize as the empty string and never call
// the encoder; a value that is a record or a number is read live when it is
// the record.
let encoderCalls = 0;
const counting = (s) => {
  encoderCalls++;
  return s;
};
console.log(
  "primitives",
  JSON.stringify([
    qs.stringify(5, null, null, { encodeURIComponent: counting }),
    qs.stringify("text", null, null, { encodeURIComponent: counting }),
    qs.stringify(true, null, null, { encodeURIComponent: counting }),
  ]),
  encoderCalls,
);
const recordOr = (n) => (n > 0 ? { k: ["a", "b"] } : n);
const either = recordOr(1);
console.log(
  "record or number",
  qs.stringify(either, null, null, {
    encodeURIComponent: (s) => {
      if (s === "k" && typeof either === "object") either.k.splice(1);
      return s;
    },
  }),
  JSON.stringify(qs.stringify(recordOr(0), null, null, { encodeURIComponent: counting })),
);
