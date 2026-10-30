// Adoption at the declaration-typed boundary: objects package code still
// references (a cache, weak keys, parsed documents, a cycle through an
// unknown field) keep their identity when they cross into typed code.
import { z } from "zod";

const Row = z.object({ id: z.number(), name: z.string(), tags: z.array(z.string()), meta: z.unknown() });
type Row = z.infer<typeof Row>;

// A package-side cache: the same objects come back from every call.
const cache: unknown[] = [];
const weak = new WeakMap<object, string>();
const Cached = z.custom<{ id: number; tags: string[] }>().transform((v) => v);
for (let i = 0; i < 4; i++) {
  const raw = JSON.parse(`{"id":${i},"name":"n${i}","tags":["a","b"],"meta":{"deep":[1,2,{"x":${i}}]}}`) as unknown;
  cache.push(raw);
  weak.set(raw as object, "w" + i);
}
let sum = 0;
for (let round = 0; round < 200; round++) {
  for (let i = 0; i < cache.length; i++) {
    const r: Row = Row.parse(cache[i]);
    sum += r.id + r.tags.length;
    const again = Row.parse(cache[i]);
    if (round === 0) console.log("fresh", r === again, r.name, JSON.stringify(r.meta));
  }
}
console.log("sum", sum);
// The package keeps the source objects; z.custom passes them through.
const kept = cache.map((c) => Cached.parse(c));
kept[0]!.tags.push("c");
console.log("kept", JSON.stringify(cache[0]), kept[0] === Cached.parse(cache[0]));
console.log("weak", weak.get(cache[1] as object), weak.has(cache[2] as object));
// A cycle through an unknown field.
const AsRow = z.custom<Row>();
const cyc: Row = { id: 9, name: "c", tags: [], meta: null };
cyc.meta = cyc;
const back = AsRow.parse(cyc);
back.id = 10;
console.log("cycle", cyc.id, back === cyc, back.meta === cyc);
// A tuple's elements keep their identity too: the package-side array
// still holds the element that typed code mutates.
const Pair = z.custom<[{ id: number; tags: string[] }, string]>();
const pairSource = JSON.parse('[{"id":1,"tags":["a"]},"s"]') as unknown[];
const pairHead = pairSource[0];
const pair = Pair.parse(pairSource);
pair[0].tags.push("b");
pair[0].id = 2;
console.log("tuple", JSON.stringify(pairHead), JSON.stringify(pairSource), pair[1]);
