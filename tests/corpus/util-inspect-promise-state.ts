// util.inspect and util.format over Promise values: a pending promise
// prints `Promise { <pending> }`, a fulfilled one its settled value, and a
// rejected one `<rejected>` before the reason. The settled value spends one
// depth level like a property (the placeholder past the budget is
// `[Promise]`), the promise's own base takes no color while its settled
// value does, and %o and %O render the same shape. Every rejected promise
// gets a handler so the program itself ends quietly.
import * as util from "node:util";

const show = (label: string, value: any, options?: any): void => {
  console.log(`${label}: ${util.inspect(value, options)}`);
};

const pending: any = new Promise(() => {});
show("pending", pending);
show("pending nested", { p: pending });

const fulfilled: any = Promise.resolve({ a: 1 });
show("fulfilled", fulfilled);
show("fulfilled primitive", Promise.resolve(7));
show("fulfilled undefined", Promise.resolve(undefined));

const deep: any = Promise.resolve({ a: { b: { c: 1 } } });
show("deep", deep);
show("deep depth0", deep, { depth: 0 });
show("deep depth1", deep, { depth: 1 });
show("deep nested", { p: deep });
show("deep nested depth0", { p: deep }, { depth: 0 });
show("deep nested depth1", { p: deep }, { depth: 1 });

const reason: any = new Error("nope");
reason.stack = "";
const rejected: any = Promise.reject(reason);
rejected.catch(() => {});
show("rejected error", rejected);
show("rejected error plain", rejected);
show("rejected error nested", { p: rejected });
show("rejected error nested depth0", { p: rejected }, { depth: 0 });
show("rejected error nested depth1", { p: rejected }, { depth: 1 });
show("rejected error depth0", rejected, { depth: 0 });

const number: any = Promise.reject(42);
number.catch(() => {});
show("rejected number", number);
const object: any = Promise.reject({ code: "X" });
object.catch(() => {});
show("rejected object", object);
const missing: any = Promise.reject(undefined);
missing.catch(() => {});
show("rejected undefined", missing);
const text: any = Promise.reject("bad");
text.catch(() => {});
show("rejected string", text);

show("colors", fulfilled, { colors: true });
show("colors pending", pending, { colors: true });
show("showHidden", fulfilled, { showHidden: true });

console.log(`format o: ${util.format("%o", fulfilled)}`);
console.log(`format O: ${util.format("%O", fulfilled)}`);
console.log(`format o nested: ${util.format("%o", { p: rejected })}`);
console.log(`formatWithOptions: ${util.formatWithOptions({ showHidden: true }, "%O", { p: 1 })}`);
console.log(`format extra: ${util.format("%s %o", "x", pending)}`);

// A settled object that points back at its promise: the promise carries a
// circular reference number and prints as [Circular *N] where it repeats,
// at any depth. The cycle is broken before the program ends so the
// reference count can release both values.
const holder: any = { a: 1 };
const looping: any = Promise.resolve(holder);
holder.p = looping;
show("cycle", looping);
show("cycle hidden", looping, { showHidden: true });
show("cycle pair", { p: looping, o: holder });
console.log(`cycle format: ${util.format("%o", looping)}`);
holder.p = undefined;
