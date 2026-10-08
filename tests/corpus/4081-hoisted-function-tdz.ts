// Function declarations are callable before the module's later let and
// const bindings are initialized. Reading or writing such a binding from a
// call that runs early throws ReferenceError; once the declaration has run
// the same functions see the value.

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, (error as Error).name, (error as Error).message);
  }
}

attempt("count", () => readCount());
attempt("title", () => titleLength());
attempt("write", () => bumpTotal());
attempt("arrow", () => early());
attempt("callback", () => [1, 2].map((n) => n + offset));

let count = 3;
const title = "inventory";
let total = 10;
const offset = 100;
const early = (): string => `early ${title}`;

function readCount(): number {
  return count;
}
function titleLength(): number {
  return title.length;
}
function bumpTotal(): number {
  total += 1;
  return total;
}

attempt("count again", () => readCount());
attempt("title again", () => titleLength());
attempt("write again", () => bumpTotal());
attempt("arrow again", () => early());
attempt("callback again", () => [1, 2].map((n) => n + offset));

// A declaration whose own initializer calls a function reading it.
function seed(): number {
  return start + 1;
}
attempt("self", () => {
  const value = seed();
  return value;
});
const start: number = 41;
attempt("self again", () => seed());

// Object methods stored before use, and timers that run after the module.
const shelf = {
  items: ["bolt", "nut"],
  first(): string {
    return this.items[0] + " " + capacity;
  },
};
attempt("method early", () => shelf.first());
const capacity = 8;
attempt("method late", () => shelf.first());
setTimeout(() => console.log("timer", late, lateLabel()), 0);
const late = "after";
function lateLabel(): string {
  return late.toUpperCase();
}
