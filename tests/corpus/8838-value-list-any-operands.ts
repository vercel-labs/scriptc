// Value-list chains over `any` operands, where the checker types every list
// any[]: callbacks with annotated and contextual parameters, a reduce at the
// end of a chain, flatMap of nested values, and Object.fromEntries.
const parsed: any = JSON.parse('{"a":{"n":1,"ok":true,"tags":["x"]},"b":{"n":2,"ok":false,"tags":[]},"c":{"n":3,"ok":true,"tags":["y","z"]}}');
console.log(Object.values(parsed).map((v: any) => v.n * 2).join(","));
console.log(Object.values(parsed).filter((v: any) => v.ok).length);
console.log(
  Object.values(parsed)
    .filter((v: any) => v.ok)
    .map((v: any) => v.n)
    .reduce((sum: number, n: number) => sum + n, 0),
);
console.log(Object.values(parsed).flatMap((v: any) => v.tags).join(""));
console.log(Object.values(parsed).flatMap((v: any) => Object.values(v)).length);
const untyped = Object.values(parsed).map((v) => (v as { n: number }).n + 1);
console.log(untyped.join(","), untyped.length);
// A rest-parameter callback receives the arguments the method passes.
console.log(
  Object.values(parsed)
    .map((...args: unknown[]) => `${args.length}${String((args[0] as { n: number }).n)}`)
    .join(","),
);
function total(input: any): number {
  return Object.values(input)
    .map((v: any) => Number(v.n))
    .reduce((a, b) => a + b, 0);
}
console.log(total(parsed), total({ x: { n: "4" } }));
const table: Record<string, any> = parsed;
console.log(Object.values(table).map((v) => v.n).join(","), Object.values(table).filter((v) => v.tags.length > 0).length);
const pairs = Object.fromEntries(Object.values(table).map((v) => [String(v.n), v.ok]));
console.log(JSON.stringify(pairs));
