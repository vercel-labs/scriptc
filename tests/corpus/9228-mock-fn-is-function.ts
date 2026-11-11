// node:test's mock.fn returns the function itself with its `.mock`
// context attached: typeof answers "function", the value stays callable,
// and an alias observes the same context. (Node implements the context as
// a Proxy; our context is a non-enumerable own property — a documented
// divergence for own-property reflection only.)
import { mock } from "node:test";
const add = mock.fn((a: number, b: number) => a + b);
console.log(add(1, 2), add(3, 4));
const alias = add;
console.log(add.mock.callCount(), alias.mock.calls[1]!.arguments, alias === add, typeof add);
console.log(add.mock.calls.map((c) => c.arguments.join("+")).join(","));
// Node keeps the context out of enumeration: no key lists it (Node hides
// it behind a proxy; ours is a non-enumerable own property — a documented
// reflection divergence).
console.log(Object.keys(add).length, JSON.stringify(add.mock.calls[0]!.arguments));
