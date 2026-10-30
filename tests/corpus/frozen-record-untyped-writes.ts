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
