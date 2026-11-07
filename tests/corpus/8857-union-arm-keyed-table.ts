// A table of typed records that goes through `object` values and is asserted
// to a keyed table type whose entries each carry their own literal id. The
// union of the table's values is then discriminated by `id`, with one literal
// per entry, and `Object.values` checks each value into that union. Each
// value already is one of the union's two record arms, so it is taken by its
// type: no literal is tested and no record is copied into a dynamic object
// (before: one copy per literal tested ahead of the value's own, quadratic in
// the table's size). The values stay the table's own entries.
type Unit = "metric" | "imperial";
interface Cost {
	input: number;
	output: number;
}
interface Item<U extends Unit> {
	id: string;
	label: string;
	unit: U;
	tags: string[];
	cost: Cost;
	ready: boolean;
	limit: number;
	opts?: U extends "metric" ? { adaptive?: boolean } : { strict?: boolean };
}
type Table = {
	"h/item-8": Item<"imperial"> & { id: "h/item-8" };
	"g/item-7": Item<"metric"> & { id: "g/item-7" };
	"f/item-6": Item<"imperial"> & { id: "f/item-6" };
	"e/item-5": Item<"imperial"> & { id: "e/item-5" };
	"d/item-4": Item<"metric"> & { id: "d/item-4" };
	"c/item-3": Item<"imperial"> & { id: "c/item-3" };
	"b/item-2": Item<"imperial"> & { id: "b/item-2" };
	"a/item-1": Item<"metric"> & { id: "a/item-1" };
};
const DATA = {
	metric: {
		"entry:a/item-1": { id: "a/item-1", label: "One", unit: "metric", ready: true, tags: ["text"], cost: { input: 1, output: 2 }, limit: 64, opts: { adaptive: true } },
		"entry:d/item-4": { id: "d/item-4", label: "Four", unit: "metric", ready: false, tags: ["text", "image"], cost: { input: 4, output: 8 }, limit: 256 },
		"entry:g/item-7": { id: "g/item-7", label: "Seven", unit: "metric", ready: true, tags: ["text"], cost: { input: 7, output: 14 }, limit: 448 },
	},
	imperial: {
		"entry:b/item-2": { id: "b/item-2", label: "Two", unit: "imperial", ready: false, tags: ["text"], cost: { input: 2, output: 4 }, limit: 128 },
		"entry:c/item-3": { id: "c/item-3", label: "Three", unit: "imperial", ready: true, tags: ["image"], cost: { input: 3, output: 6 }, limit: 192, opts: { strict: false } },
		"entry:e/item-5": { id: "e/item-5", label: "Five", unit: "imperial", ready: false, tags: ["text"], cost: { input: 5, output: 10 }, limit: 320 },
		"entry:f/item-6": { id: "f/item-6", label: "Six", unit: "imperial", ready: true, tags: ["text"], cost: { input: 6, output: 12 }, limit: 384 },
		"entry:h/item-8": { id: "h/item-8", label: "Eight", unit: "imperial", ready: false, tags: ["text"], cost: { input: 8, output: 16 }, limit: 512 },
	},
};
function flatten(groups: Record<string, Record<string, object>>): Record<string, object> {
	return Object.fromEntries(
		Object.values(groups)
			.flatMap((entries) => Object.values(entries))
			.map((entry) => [(entry as { id: string }).id, entry]),
	);
}
const TABLE = flatten(DATA) as Table;

// The values come in the source's order, each of them one of the two arms.
const values = Object.values(TABLE);
console.log(values.length, values.map((item) => item.id).join(" "));
let metric = 0;
let limit = 0;
for (const item of values) {
	if (item.unit === "metric") metric++;
	limit += item.limit;
}
console.log(metric, limit);
console.log(JSON.stringify(values[0]));
console.log(JSON.stringify(values[4]));

// A value is the table's entry: writes show through both.
const first = values[0]!;
first.limit = 1000;
first.cost.input = 100;
console.log(TABLE["a/item-1"].limit, TABLE["a/item-1"].cost.input);
TABLE["b/item-2"].label = "Two, renamed";
console.log(values.find((item) => item.id === "b/item-2")?.label);

// Collected again, the values are the same entries.
const again = Object.values(TABLE);
again[0]!.ready = false;
console.log(first.ready, again.length);

// Narrowing by the literal id reaches the entry's own arm.
function describe(item: (typeof values)[number]): string {
	if (item.id === "c/item-3") return `${item.label}: strict=${String(item.opts?.strict)}`;
	if (item.id === "a/item-1") return `${item.label}: adaptive=${String(item.opts?.adaptive)}`;
	return item.label;
}
console.log(values.map(describe).join("; "));
