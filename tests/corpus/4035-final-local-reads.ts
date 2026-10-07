type Item = { name: string; tags: string[] };

const log: string[] = [];
function take(item: Item): Item {
  item.tags.push("taken");
  return item;
}
function pair(left: Item, right: Item): string {
  return left.name + "/" + right.name + ":" + left.tags.length + "," + right.tags.length;
}
function check(item: Item): boolean {
  return item.tags.length < 5;
}
function make(name: string): Item {
  return { name, tags: [] };
}

// Several reads of one local in one statement, the final one owned by a callee.
function sameCall(): string {
  const item = make("same");
  return pair(item, take(item));
}
function afterCompleted(): boolean {
  const item = make("chain");
  return check(item) && check(take(item)) && take(item).tags.length === 2;
}
function shortCircuit(flag: boolean): string {
  const item = make("short");
  const other = flag ? item : make("other");
  return (other.tags.length > 0 ? other : take(item)).name;
}
function finallyRead(): string {
  const item = make("finally");
  try {
    return take(item).name;
  } finally {
    log.push("finally " + item.tags.join("|"));
  }
}
function catchRead(): string {
  const item = make("catch");
  try {
    if (take(item).tags.length > 0) throw new Error("boom");
    return "none";
  } catch (error) {
    return (error as Error).message + " " + item.tags.join("|");
  }
}
function loopRead(): number {
  const item = make("loop");
  let total = 0;
  for (let i = 0; i < 3; i++) total += take(item).tags.length;
  return total;
}
function returnsLocal(): Item {
  const item = make("returned");
  take(item);
  return item;
}
const callbacks: ((item: Item) => string)[] = [(item) => item.name, (item) => take(item).name];
function throughCallbacks(): string {
  const item = make("callback");
  return callbacks[0]!(item) + callbacks[1]!(item) + item.tags.length;
}

console.log(sameCall());
console.log(afterCompleted());
console.log(shortCircuit(true), shortCircuit(false));
console.log(finallyRead(), log.join(";"));
console.log(catchRead());
console.log(loopRead());
console.log(returnsLocal().tags.join(","));
console.log(throughCallbacks());
