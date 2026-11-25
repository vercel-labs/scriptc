// A package compiled from its JavaScript is called with records the program
// built. Inside the package the checker types every read through the untyped
// parameter `any`; the member's own kind (a number, a Date, a Set, a Map, a
// RegExp, a bigint, a boolean, a URL, a record with a method) has to decide
// how a method call or a read on it compiles, as it does for a parameter that
// is the value itself. Each record here has a static layout, so each function
// is compiled for that layout.
import {
  concise,
  countdown,
  depth,
  flag,
  host,
  inCallback,
  lastName,
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
} from "shelf-kit";

const priced = { id: "priced", amount: 12.3456 };
console.log(price(priced), "|", precise(priced));

const dated = { id: "dated", at: new Date(86_400_000) };
console.log(stamp(dated));

const labelled = { id: "labelled", tags: new Set(["new", "fragile"]) };
const counted = {
  id: "counted",
  counts: new Map([
    ["a", 3],
    ["b", 4],
  ]),
};
const matched = { id: "matched", pattern: /shelf-\d+/ };
console.log(tagged(labelled), stock(counted), matches(matched));

const numbered = { id: "numbered", serial: 9007199254740993n };
const gated = { id: "gated", open: true };
const linked = { id: "linked", link: new URL("https://depot.example/shelves?row=4") };
console.log(serial(numbered), flag(gated), host(linked));

const described = {
  id: "described",
  label: {
    render(): string {
      return "label of the entry";
    },
  },
};
const boxed = { id: "boxed", box: { size: { depth: 0.75 } } };
console.log(rendered(described), depth(boxed));

const both = { id: "both", amount: 12.3456, at: new Date(86_400_000) };
console.log(throughLocals(both), throughChain(priced), concise(priced));

const named = { id: "named", names: ["first", "last"] };
console.log(inCallback(priced), lastName(named));

// The same functions with other records of the same layouts: the members are
// read from the value passed.
console.log(price({ id: "half", amount: 0.5 }), flag({ id: "shut", open: false }));
console.log(lastName({ id: "one", names: ["only"] }), inCallback({ id: "half", amount: 0.5 }));
console.log(countdown({ left: 3 }));
