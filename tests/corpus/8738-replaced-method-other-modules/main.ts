// The writes that replace a method are in other modules: a TypeScript module
// that takes `unknown`, and a JavaScript module the compiler does not type
// (it also declares a class of its own). Calls in this module run before and
// after each of them.
import { patchInstance, patchPrototype, restore } from "./patch.ts";
import { Recorder, tag } from "./plain.js";

export class Queue {
  private items: string[] = [];
  push(item: string): number {
    this.items.push(item);
    return this.items.length;
  }
  size(): number {
    return this.items.length;
  }
}

class Stack extends Queue {
  top(): string {
    return `top of ${this.size()}`;
  }
}

const queue = new Queue();
const stack = new Stack();
let pushed = 0;
for (let i = 0; i < 500; i++) pushed += queue.push("x") + stack.push("y");
console.log(pushed, queue.size(), stack.size(), stack.top());

const recorder = new Recorder();
recorder.note("a");
console.log(tag(queue, "kind", "queue"), recorder.count(), queue.size());

patchInstance(queue, "size");
console.log(queue.size(), stack.size(), new Queue().size());
restore(queue, "size");
console.log(queue.size());

patchPrototype(stack, "size");
console.log(queue.size(), stack.size(), stack.top(), new Queue().size(), new Stack().size());
