// TypeScript keeps the same rule: tsc's definite-assignment analysis rejects a
// direct read above the declaration, but a function declared above may read the
// binding — every call of it follows the store, so the value is the assigned one.
function describe(count: number): string {
  return `count=${count}`;
}
var total: number = 3;
total += 4;
console.log(describe(total));
