// Iterator helpers on generators passed through `any` and `unknown`.
function* letters(): Generator<string, void, unknown> {
  yield "a";
  yield "b";
  yield "c";
}
function upper(it: any): string[] {
  return it.map((s: string) => s.toUpperCase()).toArray();
}
console.log(upper(letters()));
const boxed: unknown = letters();
console.log((boxed as any).filter((s: string) => s !== "b").toArray());
const held: any[] = [letters(), letters()];
console.log(held.map((h) => h.drop(1).toArray()));
function* numbered(): Generator<number, string, unknown> {
  yield 1;
  yield 2;
  return "end";
}
function firstTwo(it: any): number[] {
  return it.take(2).toArray();
}
const later: any = numbered();
console.log(firstTwo(numbered()), later.some((n: number) => n > 1));
