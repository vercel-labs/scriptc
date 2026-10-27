// Overrides whose parameters differ from the base: a typed parameter over
// an `any` slot, a wider (contravariant) parameter, and a narrowed result.
class Handler {
  handle(input: any): any {
    return `base:${input}`;
  }
  score(value: string): number | undefined {
    return value.length;
  }
}
class TypedHandler extends Handler {
  override handle(input: string): string {
    return `typed:${input.toUpperCase()}`;
  }
  override score(value: string | number): number {
    return typeof value === "string" ? value.length * 10 : value;
  }
}
function run(h: Handler): void {
  console.log(h.handle("abc"), h.score("xy"));
}
run(new Handler());
run(new TypedHandler());
const typed = new TypedHandler();
console.log(typed.handle("q"), typed.score(7));
try {
  run2(new TypedHandler());
} catch (e) {
  console.log("caught", (e as Error).name);
}
function run2(h: Handler): void {
  console.log(h.handle(42));
}
