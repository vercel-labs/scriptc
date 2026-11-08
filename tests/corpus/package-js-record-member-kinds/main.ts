// A package compiled from its JavaScript is called with a record the program
// built. Inside the package the checker types every read through the untyped
// parameter `any`; the member's own kind (a number, a Date, a Set, a Map, a
// RegExp, a bigint, a boolean, a URL, a record with a method) has to decide
// how a method call or a read on it compiles, as it does for a parameter that
// is the value itself.
import {
  concise,
  depth,
  flag,
  host,
  inCallback,
  lastTag,
  matches,
  precise,
  price,
  rendered,
  serial,
  stamp,
  stock,
  tagged,
  throughChain,
  throughLocals,
  type Entry,
} from "shelf-kit";

const entry: Entry = {
  amount: 12.3456,
  at: new Date(86_400_000),
  tags: new Set(["new", "fragile"]),
  counts: new Map([
    ["a", 3],
    ["b", 4],
  ]),
  pattern: /shelf-\d+/,
  serial: 9007199254740993n,
  open: true,
  link: new URL("https://depot.example/shelves?row=4"),
  label: {
    render() {
      return "label of the entry";
    },
  },
  box: { size: { depth: 0.75 } },
  names: ["first", "last"],
};

console.log(price(entry), "|", precise(entry));
console.log(stamp(entry));
console.log(tagged(entry), stock(entry), matches(entry));
console.log(serial(entry), flag(entry), host(entry));
console.log(rendered(entry), depth(entry));
console.log(throughLocals(entry), throughChain(entry), concise(entry));
console.log(inCallback(entry), lastTag(entry));

// The same functions with another record of the same type: the members are
// read from the value passed, not from the first one.
const other: Entry = { ...entry, amount: 0.5, open: false, names: ["only"] };
console.log(price(other), flag(other), lastTag(other), inCallback(other));
