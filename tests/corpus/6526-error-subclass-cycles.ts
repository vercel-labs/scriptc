// Inspecting Error subclasses whose fields hold the same class or one of
// its bases: a chain renders each link, and a cycle renders as Node's
// circular reference (`<ref *1>` and `[Circular *1]`), also when the cycle
// runs through a base-typed field of a subclass or through an object's
// Error-typed field. (The stack is cleared: compiled errors carry none.)
import * as util from "node:util";
class Chain extends Error {
  next: Chain | undefined = undefined;
}
class Tagged extends Chain {
  tag = "t";
}
function clean<E extends Error>(e: E): E {
  e.stack = "";
  return e;
}
function show(e: Error): void {
  console.log(util.inspect(e));
}

const tail = clean(new Chain("tail"));
const head = clean(new Chain("head"));
head.next = tail;
show(head);
console.log(util.inspect({ wrapped: { head } }));

const loop = clean(new Chain("loop"));
loop.next = loop;
show(loop);

const a = clean(new Tagged("a"));
const b = clean(new Chain("b"));
a.next = b;
b.next = a;
show(a);
show(b);
show(clean(new Error("plain")));

class Holder {
  err: Error | undefined = undefined;
}
class Held extends Error {
  holder = new Holder();
}
const held = clean(new Held("held"));
held.holder.err = held;
console.log(util.inspect(held.holder));
show(held);
