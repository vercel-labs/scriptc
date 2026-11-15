// @requires-libnode
// Values an island made cross the boundary as checked-dynamic handles. A
// checked conversion (`as Item`, `as { label: string }`, `as number[]`)
// reads the members through the handle, and JSON.stringify, Object.keys
// and object spread read the island object's own properties.
import { makeBody, makeCounting, makeCycle, makeHidden, makeHooks, makeInherited, makeList, makeProxyList, makeShapes, makeSymbols, makeWithMembers } from "value-pkg";

interface Item {
  label: string;
  count: number;
  nested: { flag: boolean };
  tags: string[];
}

const body = makeBody();

const item = body as Item;
console.log("cast", item.label, item.count, item.nested.flag, item.tags.join(","));

const narrow = body as { label: string };
console.log("narrow", narrow.label);

console.log("stringify", JSON.stringify(body));
console.log("keys", Object.keys(body).join(","));
console.log("values", Object.values(body).map((v) => typeof v).join(","));

const spread = { ...body };
console.log("spread", spread.label, spread.count, typeof spread.nested);
const spreadInto = { first: true, ...body };
console.log("spread into", spreadInto.first, spreadInto.label);

const list = makeList();
const nums = list as number[];
console.log("array", nums.length, nums.join("-"));
console.log("array stringify", JSON.stringify(list));
console.log("in operator", "label" in body, "missing" in body);
console.log("destructured", (() => {
  const { label, count } = body as Item;
  return `${label}:${count}`;
})());

// A method, an accessor and an undefined member keep their JavaScript
// meaning: stringify runs toJSON in Node and omits the function and the
// undefined member, while a field read reaches the accessor.
const hooks = makeHooks();
console.log("toJSON", JSON.stringify(hooks));

const members = makeWithMembers();
console.log("members", JSON.stringify(members));
console.log("accessor", (members as { size: number }).size, Object.keys(members).join(","));
const copiedMembers = { ...members };
console.log("copied", copiedMembers.size, typeof copiedMembers.run, "missing" in copiedMembers);

// An index-signature record captures the object's own keys, and its declared
// fields are ordinary property reads: a member the object inherits or
// defines as non-enumerable still answers.
const inherited = makeInherited() as { [k: string]: string | number; label: string };
console.log("inherited", inherited.label, inherited.count);

const hidden = makeHidden() as { [k: string]: number; hidden: number };
console.log("hidden", hidden.hidden, hidden["visible"]);

// A target that declares no field of its own converts through the same
// object view, with an empty declared-field table: every own key converts.
function listNumbers(r: { [k: string]: number }): string {
  return `${Object.keys(r).join(",")}:${r["visible"]}`;
}
console.log("fieldless", listNumbers(makeHidden()));

// An index-signature record's declared field is a getter: the conversion
// that builds the record at the call reads it once, so the callee sees the
// getter's first answer.
function countIndexed(r: { [k: string]: number; counted: number }): string {
  return `${r.counted}:${r.plain}`;
}
console.log("counting", countIndexed(makeCounting()));

// Passing the island object where a parameter declares an index-signature
// record builds the record at the call, so its declared fields read the
// object the same way.
function describeIndexed(r: { [k: string]: string | number; label: string }): string {
  return `${r.label}:${r.count}`;
}
console.log("parameter", describeIndexed(makeInherited()));

function sumNumbered(r: { [k: string]: number; hidden: number }): number {
  return r.hidden + r["visible"];
}
console.log("parameter numbered", sumNumbered(makeHidden()));

// A cyclic island object converts once: a member read that answers the same
// object again keeps the record already built for it.
interface Link {
  name: string;
  next?: Link;
}
const link = makeCycle() as Link;
console.log("cycle", link.name, link.next!.name, link.next!.next!.name);

// A spread copies the island function onto a native object: JSON.stringify
// runs that copy's toJSON, as it would for any callable member.
const hookCopy = { ...makeHooks() };
console.log("spread toJSON", JSON.stringify(hookCopy));

// A symbol has no JSON text: an object member is omitted and an array
// element is null, and typeof still answers symbol.
const symbols = makeSymbols();
console.log("symbol", typeof symbols.tag, JSON.stringify(symbols), JSON.stringify(symbols.list));
console.log("symbol top", JSON.stringify(symbols.tag));

// Array.isArray follows a proxy to its target, so a proxied array converts
// and serializes as the array it is.
const proxied = makeProxyList();
const proxiedNums = proxied as number[];
console.log("proxy array", Array.isArray(proxied), proxiedNums.length, JSON.stringify(proxied));

// A discriminated union whose four string literals take the one-read
// dispatch: the native table cannot see an island object's members, so the
// match falls back to the literal tests, which read the discriminant
// through the handle, and the record arm then matches.
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "triangle"; base: number; height: number }
  | { kind: "line"; length: number };
const shapes = makeShapes() as Shape[];
console.log(
  "shapes",
  shapes
    .map((shape) =>
      shape.kind === "circle"
        ? shape.radius
        : shape.kind === "square"
          ? shape.side
          : shape.kind === "triangle"
            ? shape.base + shape.height
            : shape.length,
    )
    .join(","),
);
