// @requires-libnode
// Values an island made cross the boundary as checked-dynamic handles. A
// checked conversion (`as Item`, `as { label: string }`, `as number[]`)
// reads the members through the handle, and JSON.stringify, Object.keys
// and object spread read the island object's own properties.
import { makeBody, makeHooks, makeList, makeWithMembers } from "value-pkg";

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
