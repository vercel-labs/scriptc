// A function value that reaches text only through Array.prototype.join: the
// checked-dynamic join converts each element the way a coercion does, so the
// joined row prints source text rather than the native-code form, and the
// program needs its source-text table even though it calls nothing else that
// prints a function.

function greet(name: string): string {
  return "hi " + name;
}

const arrow = (n: number): number => n + 1;

const values: unknown[] = [greet, arrow, "done"];
console.log(values.join(", "));

const untyped: any[] = [greet, arrow];
console.log(untyped.join(" | "));

const empty: unknown[] = [];
console.log(empty.join(", "));
