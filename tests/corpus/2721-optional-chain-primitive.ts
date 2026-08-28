// Optional chains over primitive receivers with optional params: `val?.trim()`
// short-circuits to undefined on the nullish path, chains compose
// (`?.trim()?.toLowerCase()`), a single `?.` guards a whole dotted tail
// (`val?.trim().toLowerCase()`), and null receivers short-circuit too.
export function cleanInput(val?: string): string | undefined {
  return val?.trim();
}
console.log(cleanInput("  hi  ") ?? "undef");
console.log(cleanInput(undefined) ?? "undef");
console.log(cleanInput("  ") === "");

export function lowerTrim(val?: string) {
  return val?.trim()?.toLowerCase();
}
console.log(lowerTrim("  HELLO "));
console.log(lowerTrim(undefined) ?? "undef");

// one ?. guarding a two-step method tail (no second ?.)
export function guardTail(val?: string): string | undefined {
  return val?.trim().toLowerCase();
}
console.log(guardTail("  MiXeD  ") ?? "undef");
console.log(guardTail(undefined) ?? "undef");

// number receiver through ?.
export function numFix(n?: number): string | undefined {
  return n?.toFixed(2);
}
console.log(numFix(3.14159) ?? "undef");
console.log(numFix(undefined) ?? "undef");

// null receiver: still undefined, JS-exact
export function nullTrim(val: string | null): string | undefined {
  return val?.trim();
}
console.log(nullTrim(null) ?? "undef");
console.log(nullTrim("  pad  ") === "pad");

// chained call result feeds a further primitive op through ??
console.log((lowerTrim("  X  ") ?? "FALLBACK").length);
