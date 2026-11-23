// Functions that read `arguments.length` stored where a variadic function
// type is expected: the count comes from the arguments each call passes.
function count(): void {
  console.log("count", arguments.length);
}
const asRest: (...args: unknown[]) => void = count;
asRest(1, 2, 3);
asRest();

const tag = (...args: unknown[]) => {
  console.log("tag", args.length);
};
function named(a: string, b: number): void {
  console.log("named", a, b, arguments.length, tag(a, b));
}
const namedAsRest: (...args: any[]) => void = named;
namedAsRest("x", 5, true);

function spread(a: unknown, b: unknown): void {
  console.log("spread", arguments.length);
}
const spreadAsRest: (...args: unknown[]) => void = spread;
spreadAsRest();
spreadAsRest(1);
spread(1, 2);
