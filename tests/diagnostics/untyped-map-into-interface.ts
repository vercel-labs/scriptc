// An untyped `new Map()` satisfies a record interface only through `any`;
// its flow into the interface-typed result is refused at build time, like a
// typed Map is.
interface Cache {
  get(key: string): number | undefined;
  set(key: string, value: number): unknown;
}
function make(c?: Cache): Cache {
  return c ?? new Map();
}
console.log(make().get("a"));
export {};
