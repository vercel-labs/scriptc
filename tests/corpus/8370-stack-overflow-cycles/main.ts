// Unbounded recursion through each kind of call cycle raises Node's
// RangeError, and the program recovers and recurses again afterwards.
import { Even, Odd, Tree } from "./shapes.ts";

function probe(name: string, run: (n: number) => number): void {
  try {
    console.log(name, "returned", run(10_000_000));
  } catch (e) {
    console.log(name, e instanceof RangeError, (e as Error).message);
  }
  console.log(name, "after", run(100));
}

function down(n: number): number {
  return n === 0 ? 0 : 1 + down(n - 1);
}
probe("direct", down);

function ping(n: number): number {
  return n === 0 ? 0 : 1 + pong(n - 1);
}
function pong(n: number): number {
  return n === 0 ? 0 : 2 + ping(n - 1);
}
probe("mutual", ping);

function first(n: number): number {
  return n === 0 ? 0 : 1 + second(n - 1);
}
function second(n: number): number {
  return n === 0 ? 0 : 1 + third(n - 1);
}
function third(n: number): number {
  return n === 0 ? 0 : 1 + fourth(n - 1);
}
function fourth(n: number): number {
  return n === 0 ? 0 : 1 + fifth(n - 1);
}
function fifth(n: number): number {
  return n === 0 ? 0 : 1 + first(n - 1);
}
probe("ring", first);

function viaValue(n: number, again: (m: number) => number): number {
  return n === 0 ? 0 : 1 + again(n - 1);
}
const callback = (m: number): number => viaValue(m, callback);
probe("closure", callback);

function viaMap(n: number): number {
  return n === 0 ? 0 : 1 + [n - 1].map(viaMap)[0]!;
}
probe("library callback", viaMap);

const even = new Even();
const odd = new Odd();
even.next = odd;
odd.next = even;
probe("virtual", (n) => even.depth(n));

probe("constructor", (n) => {
  let tree: Tree | null = new Tree(n);
  let count = 0;
  while (tree !== null) {
    count++;
    tree = tree.child;
  }
  return count;
});
