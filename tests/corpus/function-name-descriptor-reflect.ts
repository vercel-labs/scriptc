/* Reflecting over a function before its own-property table exists creates
 * that table, and the name the function answers afterwards is the name the
 * function itself has: its declaration name, the binding an anonymous
 * function was assigned to, or the name an inner function expression spells.
 * Opening the table through getOwnPropertyNames, freeze or defineProperty
 * leaves that name alone. */

function declared(): number {
  return 1;
}
const arrow = (): number => 2;
const expr = function (): number {
  return 3;
};
const namedExpr = function inner(): number {
  return 4;
};

/** A value the checker knows only as `unknown`, so the descriptor read lowers
 * through the dynamic path. */
function describe(target: unknown): string {
  const descriptor = Object.getOwnPropertyDescriptor(target as object, "name");
  return descriptor === undefined ? "none" : JSON.stringify(descriptor);
}

const reflected = (): number => 5;
Object.getOwnPropertyNames(reflected);
console.log("names then name", describe(reflected));
console.log(
  "names then name, direct",
  JSON.stringify(Object.getOwnPropertyDescriptor(reflected, "name")),
);

const frozen = (): number => 6;
Object.freeze(frozen);
console.log("freeze then name", describe(frozen));

const tagged = (): number => 7;
Object.defineProperty(tagged, "tag", { value: "t", writable: true, configurable: true });
console.log("expando then name", describe(tagged));

console.log("declared", describe(declared));
console.log("arrow", describe(arrow));
console.log("expr", describe(expr));
console.log("inner", describe(namedExpr));

const pick = declared;
console.log("alias", describe(pick));

const arr = [declared, arrow];
console.log("index", describe(arr[0]), describe(arr[1]));
