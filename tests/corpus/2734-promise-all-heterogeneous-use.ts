// A heterogeneous Promise.all tuple must stay Promise-typed outside an async
// function. The tuple's values remain positional after the awaited call, and
// its input expressions still evaluate left-to-right.
let order = "";

function stringEntry(): Promise<string> {
  order += "s";
  return Promise.resolve("hello");
}

function numberEntry(): Promise<number> {
  order += "n";
  return Promise.resolve(42);
}

function pair(): Promise<[string, number]> {
  return Promise.all([stringEntry(), numberEntry()] as const);
}

const pending = pair();
console.log("type:", typeof pending);
console.log("order:", order);
const values = await pending;
console.log("values:", values[0], values[1]);

const chained = pair().then((result) => `${result[0]}:${result[1]}`);
console.log("chained:", await chained);
