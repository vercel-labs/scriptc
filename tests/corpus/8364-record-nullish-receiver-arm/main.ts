// A conditional receiver whose arm reads a record with a fallback for a
// missing key, `(c ? names[k] ?? fallback(k) : other)`: the fallback's
// fresh string lives until the read of its length.
const names: Record<string, string> = { a: "alpha" };
let made = 0;
function fallback(k: string): string | undefined {
  made++;
  return k === "none" ? undefined : `fallback for ${k} #${made}`.repeat(2);
}
function asserted(useNames: boolean, k: string, other: string): number {
  return (useNames ? (names[k] ?? fallback(k)) : other)!.length;
}
function optional(useNames: boolean, k: string, other: string): number | undefined {
  return (useNames ? (names[k] ?? fallback(k)) : other)?.length;
}
function upper(useNames: boolean, k: string, other: string): string | undefined {
  return (useNames ? (names[k] ?? fallback(k)) : other)?.toUpperCase();
}
for (const k of ["a", "b", "none"])
  for (const useNames of [true, false]) {
    let length: number | string;
    try {
      length = asserted(useNames, k, "other");
    } catch (e) {
      length = (e as Error).name;
    }
    console.log(k, useNames, length, optional(useNames, k, "other"), upper(useNames, k, "x"));
  }
console.log("made", made);
