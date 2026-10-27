// Integrity operations on typed functions keep their names: the first one
// creates the function's property table, whose `name` must be the
// function's own. Queries on functions no operation has touched answer
// without creating a table.
function hashC(x: number): number {
  return x + 1;
}
const arrow = (s: string): string => s + "!";
const untouched = (a: number, b: number): number => a * b;
console.log(Object.isFrozen(untouched), Object.isSealed(untouched), Object.isExtensible(untouched));
Object.freeze(hashC);
Object.seal(arrow);
console.log(Object.isFrozen(hashC), Object.isSealed(hashC), Object.isExtensible(hashC), hashC(1));
console.log(Object.isFrozen(arrow), Object.isSealed(arrow), Object.isExtensible(arrow), arrow("a"));
function later(): number {
  return 7;
}
Object.preventExtensions(later);
console.log(Object.isFrozen(later), Object.isSealed(later), Object.isExtensible(later), later());
const functions: any[] = [hashC, arrow, untouched, later];
console.log(functions.map((f) => `${f.name}/${f.length}`).join(" "));
