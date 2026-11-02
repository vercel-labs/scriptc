// A member only an asserted intersection declares, read off a record that
// holds the property in its kept source: `item as Base & { icons?: unknown }`.
// Node erases the assertion, so the read answers what the object carries —
// the value when the source has the key, undefined when it does not. The
// binding keeps the layout it was built with and answers the added member
// from that layout's kept source (one answer for the binding, the plain
// member read, the optional chain, and the destructuring twin).

interface Base {
  name: string;
}

interface WithIcons extends Base {
  icons?: unknown;
}

const item = JSON.parse('{"name":"n","icons":["a"],"other":7}') as Base;
const bare = JSON.parse('{"name":"b"}') as Base;

// A const binding: reads answer off the object, and so do keys, JSON and
// identity — the assertion only widened the checker's view.
const view = item as Base & { icons?: unknown };
console.log("binding", String(view.icons), String(view?.icons), view.name);
console.log(
  "object",
  Object.keys(view).join(","),
  JSON.stringify(view),
  String(view === item),
  String("icons" in view),
);

// The plain member read, with no binding in between.
console.log("inline", String((item as Base & { icons?: unknown }).icons));
console.log("inline-chain", String((item as Base & { icons?: unknown })?.icons));

// A source without the key: Node binds undefined, and so does the read.
const missing = bare as Base & { icons?: unknown };
console.log("missing", String(missing.icons), String(missing?.icons));
console.log("missing-object", Object.keys(missing).join(","), JSON.stringify(missing));

// Destructuring answers the same value, with and without a default.
const { icons } = item as Base & { icons?: unknown };
const { icons: absent = ["d"] as unknown } = bare as Base & { icons?: unknown };
console.log("destructure", String(icons), JSON.stringify(absent));

// A declared interface the value is asserted to: the member is a real
// optional field of the asserted type.
const typed = item as WithIcons;
console.log("interface", String(typed.icons), typed.name);

// A source built from an object literal, and one a call returns.
const literal = { name: "l", icons: ["c"] } as Base;
function make(): Base {
  return JSON.parse('{"name":"m","icons":["e"]}') as Base;
}
console.log(
  "sources",
  String((literal as Base & { icons?: unknown }).icons),
  String((make() as Base & { icons?: unknown }).icons),
);

// The same read in a function body, for a value and for its absence.
function read(base: Base): string {
  const opts = base as Base & { icons?: unknown };
  return String(opts.icons) + "/" + opts.name;
}
console.log("fn", read(item), read(bare));

// A write to a member the stored layout DECLARES keeps reaching the object.
const writable = item as Base & { icons?: unknown };
writable.name = "renamed";
console.log("write", writable.name, String(writable.icons), JSON.stringify(item));
