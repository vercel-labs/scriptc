// A frozen native record or array seen through an untyped reference keeps
// its frozen state: strict-mode writes throw Node's TypeErrors and leave
// the value unchanged, and Object.isFrozen answers true through any name.
export {};

function write(target: unknown, key: string, value: unknown): void {
  try {
    (target as Record<string, unknown>)[key] = value;
    console.log("wrote", key);
  } catch (e) {
    console.log("threw", (e as Error).message);
  }
}

const literal = Object.freeze({ a: 1, b: "x" });
function make(n: number) {
  return Object.freeze({ a: n, tags: ["t"] });
}
const made = make(2);
write(literal, "a", 5);
write(literal, "z", 5);
write(made, "a", 7);
write(made, "tags", []);
made.tags.push("u");
console.log(literal.a, made.a, JSON.stringify(literal), JSON.stringify(made));
console.log(Object.isFrozen(literal), Object.isFrozen(made), Object.isFrozen(made.tags));

const list = Object.freeze([1, 2]);
write(list, "0", 9);
write(list, "5", 9);
console.log(list[0], list.length, Object.isFrozen(list));

const open = { a: 1 };
write(open, "a", 3);
console.log(open.a);

// A helper specialized for the record it is handed stores the value as a
// native field write, and a frozen record refuses that write the same way.
type Box = { hits: number; tag: string };

function setHits(box: any): number {
  box.hits = 42;
  return 1;
}

const freshBox: Box = { hits: 0, tag: "fresh" };
setHits(freshBox);
console.log("fresh", freshBox.hits, freshBox.tag);

const frozenBox: Box = { hits: 0, tag: "frozen" };
Object.freeze(frozenBox);
try {
  setHits(frozenBox);
  console.log("frozen wrote");
} catch (e) {
  console.log("frozen threw", (e as Error).message);
}
console.log("after", frozenBox.hits);
