// A for-of loop over a generator closes it on every early exit: return,
// a throw from the body, a labeled jump, and the enclosing generator being
// closed or thrown into while suspended inside the loop. Exhausted
// generators and generators whose own step threw are not closed again.

const log: string[] = [];

function* shelf(tag: string): Generator<string, void, undefined> {
  try {
    yield `${tag}-a`;
    yield `${tag}-b`;
  } finally {
    log.push(`close ${tag}`);
  }
}

function firstOf(tag: string): string {
  for (const item of shelf(tag)) return item;
  return "none";
}
console.log(firstOf("ret"), log.splice(0).join(","));

try {
  for (const item of shelf("thr")) throw new Error(`stop at ${item}`);
} catch (error) {
  console.log((error as Error).message, log.splice(0).join(","));
}

outer: for (const round of [1, 2]) {
  for (const item of shelf(`lbl${round}`)) {
    if (item.endsWith("a")) continue outer;
  }
}
console.log("labeled", log.splice(0).join(","));

function* crates(): Generator<string, number, undefined> {
  yield "start";
  for (const item of shelf("inner")) yield item;
  return 0;
}
const closing = crates();
closing.next();
closing.next();
const closed = closing.return(7);
console.log("outer return", closed.done, closed.value, log.splice(0).join(","));

const throwing = crates();
throwing.next();
throwing.next();
try {
  throwing.throw(new Error("injected"));
} catch (error) {
  console.log((error as Error).message, log.splice(0).join(","));
}

for (const item of shelf("full")) log.push(item);
console.log("exhausted", log.splice(0).join(","));

function* failing(): Generator<number, void, undefined> {
  try {
    yield 1;
    throw new Error("step failed");
  } finally {
    log.push("failing finally");
  }
}
try {
  for (const n of failing()) log.push(`got ${n}`);
} catch (error) {
  console.log((error as Error).message, log.splice(0).join(","));
}
