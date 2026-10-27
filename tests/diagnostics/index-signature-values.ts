// SC2006: index-signature object types outside the supported shape.
// String- and number-keyed signatures over the supported value types
// compile — functions (the command-registry pattern), Maps, Sets, and
// nested index-signature records included (differential corpus); these
// do not.

// A symbol-keyed signature has no lowering.
const bySymbol: { [s: symbol]: number } = {};
console.log(bySymbol);

// Dual signatures whose value types intern DIFFERENTLY cannot share the
// one store (tsc requires only assignability, but the store gives one
// answer per key).
const dual: { [k: string]: string | number; [n: number]: number } = {};
console.log(dual);
