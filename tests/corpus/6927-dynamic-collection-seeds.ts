// Set and Map seeds held as any: native iterators and generators.
function* values(): Generator<number> { yield 1; yield 2; yield 2; }
function* pairs(): Generator<[string, number]> { yield ["a", 1]; yield ["b", 2]; }
const m = new Map<string, number>([["x", 1], ["y", 2]]);
const anyKeys: any = m.keys();
const anyGen: any = values();
const anyPairs: any = pairs();
console.log(new Set(anyKeys).size, new Set(anyGen).size, new Map(anyPairs).size);
console.log(new Set(values()).size, new Map(pairs()).get("b"), new Set(m.values()).size);
