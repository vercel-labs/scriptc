// A typed array that reaches an untyped boundary works like Node: it keeps
// its identity, its writes are the caller's, and it seeds a Set, a Map or
// Array.from with its elements. The first case is React DOM's startup table.
import { add, from, list, pairs, same, sizeOf } from "./helpers.js";

const mediaEventTypes =
  "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " ",
  );
const nonDelegated = new Set(
  "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(mediaEventTypes),
);
console.log(
  nonDelegated.size,
  [...nonDelegated].join("|"),
  nonDelegated.has("cancel"),
  nonDelegated.has("play"),
  nonDelegated.has("click"),
);

// A typed array crossing into untyped JavaScript and back is the same array
// there and here: both names see each other's writes.
const words: string[] = ["one"];
const back = same(words) as string[];
console.log(back === words, add(words, "two"), words.length, back[1], back === words);
back.push("three");
console.log(words.length, words[2]);
console.log(sizeOf(words), from(words).length);

// The result of an untyped call is a dynamic array; concatenating it onto a
// typed one keeps every element, and the mixed array seeds a Set.
const joined = words.concat(list() as string[]);
console.log(joined.length, joined[3], new Set(joined).size, Array.from(joined).join(","));

// A typed array in an `unknown` slot keeps its identity, its length and its
// element writes, and an `unknown[]` slot is the same array again.
const unknownView: unknown = words;
console.log(unknownView === words, Array.isArray(unknownView), JSON.stringify(unknownView));
const untypedList: unknown[] = words;
console.log(untypedList === (words as unknown[]), untypedList.length);
untypedList.push("four");
console.log(words.length, words[3]);
(words as unknown[])[0] = "zero";
console.log(words[0], untypedList[0]);

// Arrays of records cross the same way: the elements keep their identity
// and their fields are one object seen through both names.
const rows: { name: string; hits: number }[] = [{ name: "a", hits: 1 }];
const rowsBack = same(rows) as { name: string; hits: number }[];
console.log(rowsBack === rows, rowsBack[0] === rows[0]);
rowsBack[0]!.hits = 7;
console.log(rows[0]!.hits, JSON.stringify(rows));

// A Set takes object elements by identity, including a dynamic array cast
// inline at the seed.
const rowSet = new Set(rows);
console.log(rowSet.size, rowSet.has(rows[0]!), rowSet.has({ name: "a", hits: 7 }));
const dynRows: unknown = rows;
const fromDyn = new Set(dynRows as { name: string; hits: number }[]);
console.log(fromDyn.size, fromDyn.has(rows[0]!));

// A seed cast from a dynamic value converts each element and keeps its
// identity: the object the Set holds is the one the untyped name reads.
const dynOnly: unknown = [{ label: "one" }];
const dynSet = new Set(dynOnly as { label: string }[]);
const dynList = dynOnly as { label: string }[];
dynList[0]!.label = "two";
console.log(dynSet.has(dynList[0]!), [...dynSet][0]!.label, dynList[0]!.label);

// A fixed tuple seed is the same sequence: each position keeps its identity.
const dynTuple: unknown = [{ label: "one" }];
const tupleSet = new Set(dynTuple as [{ label: string }]);
const tupleBack = dynTuple as { label: string }[];
tupleBack[0]!.label = "tuple";
console.log(tupleSet.size, tupleSet.has(tupleBack[0]!), [...tupleSet][0]!.label);

// Maps and typed arrays are objects too: a Set of them holds each one.
const counts = new Map([["a", 1]]);
const names = new Set(["a"]);
const buffer = new Uint8Array([1, 2]);
const objectSets = new Set<object>([counts, names, buffer, counts]);
console.log(objectSets.size, objectSets.has(counts), objectSets.has(names), objectSets.has(buffer));
counts.set("b", 2);
console.log(objectSets.has(counts), counts.size);

// A Map seeded from a typed pair array and from an untyped one keeps both.
const typedPairs: [string, number][] = [["typed", 1]];
const seeded = new Map(typedPairs);
const untypedPairs = new Map(pairs() as any);
console.log(seeded.size, seeded.get("typed"), untypedPairs.size, untypedPairs.get("from-js"));
const merged = new Map([...seeded, ...untypedPairs]);
console.log(merged.size, [...merged.keys()].sort().join(","));

// Duplicates collapse by value for a scalar Set and by identity for objects.
console.log(new Set(["a", "a", "b"]).size, new Set([rows[0]!, rows[0]!, rows[1] ?? rows[0]!]).size);
