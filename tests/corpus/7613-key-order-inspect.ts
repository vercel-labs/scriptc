import { inspect } from "node:util";

// console.log and util.inspect of object literals that write the same keys
// in different orders, alone and nested.
const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
console.log(a, b, c);
console.log([a, b, c]);
console.log({ outer: { inner: b }, list: [c] });
console.log(inspect(b, { depth: 0 }), inspect({ deep: { deeper: c } }, { depth: 0 }));
console.log(`${inspect(c)} / ${inspect(a)}`);
