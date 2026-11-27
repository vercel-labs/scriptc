/* A static read or call through `(await import("node:module")).Module`
 * evaluates the awaited import where the member stands, so its microtask hop
 * runs before the call's own arguments — as it does in Node. */
const order = [];
const mark = (label, value) => {
  order.push(label);
  return value;
};
queueMicrotask(() => order.push("microtask"));
const called = (await import("node:module")).Module.isBuiltin(mark("arg", "node:fs"));
order.push(`called:${called}`);
const read = (await import("node:module")).Module[mark("key", "name")];
order.push(`read:${read}`);
const missing = (await import("node:module")).Module.marked;
order.push(`missing:${String(missing)}`);
const staticValue = (await import("node:module")).Module.builtinModules;
order.push(`static:${Array.isArray(staticValue)}`);
const literal = (await import("node:module")).Module["isBuiltin"];
order.push(`literal:${typeof literal}`);
console.log(order.join(" | "));
