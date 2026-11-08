// A typed record that travels as `unknown` and is checked back into a union
// of record types is still the same object: the checked conversion takes a
// value that already is one of the union's arms by its type, before any arm
// reads a member, and unboxes it. Writes through either reference show in
// the other, and the keys, their order and the JSON text are the record's.
// Before, each literal guard tested ahead of the value's own arm copied the
// record into a dynamic object to read one member, and a wider record arm
// tried first accepted a copy, so a write through the union value was lost.
import { deepStrictEqual } from "node:assert";
import { isDeepStrictEqual } from "node:util";

type Circle = { kind: "circle"; r: number; name: string };
type Square = { kind: "square"; side: number; name: string };
type Tri = { kind: "tri"; base: number; name: string };
type Hex = { kind: "hex"; edge: number; name: string };
type Shape = Circle | Square | Tri | Hex;
type Small = Circle | Square;

const circle: Circle = { kind: "circle", r: 1, name: "c" };
const square: Square = { kind: "square", side: 2, name: "s" };
const hex: Hex = { kind: "hex", edge: 3, name: "h" };
const loose: unknown[] = [circle, square, hex];

// Four literals: the arm is chosen from one read of the discriminant.
const wide = loose[0] as Shape;
if (wide.kind === "circle") {
	wide.r = 9;
	console.log("four literals, write seen by source:", circle.r);
	circle.r = 11;
	console.log("four literals, source write seen:", wide.r);
	const expected: Circle = { kind: "circle", r: 11, name: "c" };
	deepStrictEqual(wide, expected);
}
const last = loose[2] as Shape;
if (last.kind === "hex") {
	last.edge += 1;
	console.log("last arm, write seen by source:", hex.edge);
}

// Two literals: one literal test per arm.
const small = loose[1] as Small;
if (small.kind === "square") {
	small.side = 7;
	console.log("two literals, write seen by source:", square.side);
	square.side = 8;
	console.log("two literals, source write seen:", small.side);
}
console.log(JSON.stringify(wide), JSON.stringify(small), JSON.stringify(last));
console.log(Object.keys(wide).join(","), Object.keys(small).join(","));
console.log(isDeepStrictEqual(wide, circle), isDeepStrictEqual(small, square), isDeepStrictEqual(wide, small));

// No discriminant, and the other arm is wider: the value is its own arm, not
// a copy that the wider arm accepts.
type Point = { x: number; name: string };
type Noted = { x: number; name: string; note?: string };
const point: Point = { x: 1, name: "p" };
const held: unknown = point;
const either = held as Point | Noted;
either.x = 5;
console.log("wider arm beside it, write seen by source:", point.x);
point.x = 6;
console.log("wider arm beside it, source write seen:", either.x);
console.log("note" in either, JSON.stringify(either), Object.keys(either).join(","));

// Beside unit and primitive arms.
const maybe = held as Point | undefined;
if (maybe !== undefined) {
	maybe.x = 21;
	console.log("optional, write seen by source:", point.x);
}
const mixed = held as string | number | Point;
if (typeof mixed !== "string" && typeof mixed !== "number") {
	mixed.x = 22;
	console.log("beside primitives, write seen by source:", point.x);
}
const nullable = held as Point | null;
if (nullable !== null) {
	nullable.x = 23;
	console.log("nullable, write seen by source:", point.x);
}

// An array of the union: each element is its own arm.
const shapes = loose as Shape[];
let total = 0;
for (const shape of shapes) {
	if (shape.kind === "circle") {
		shape.r = 30;
		total += shape.r;
	} else if (shape.kind === "square") {
		shape.side = 40;
		total += shape.side;
	} else if (shape.kind === "hex") {
		total += shape.edge;
	}
}
console.log("array elements, writes seen by sources:", circle.r, square.side, total);

// An array arm and a class arm.
const words: string[] = ["a", "b"];
const text: unknown = words;
const list = text as string | string[];
if (typeof list !== "string") {
	list.push("c");
	console.log("array arm, push seen by source:", words.join(""));
}
class Meter {
	value: number;
	constructor(value: number) {
		this.value = value;
	}
	bump(): number {
		return ++this.value;
	}
}
class Gauge extends Meter {
	label = "gauge";
}
const gauge = new Gauge(1);
const boxed: unknown = gauge;
const instrument = boxed as Meter | Point;
if (instrument instanceof Meter) {
	instrument.bump();
	console.log("class arm, call seen by source:", gauge.value, instrument instanceof Gauge);
}

// A record of another type that fits an arm is read as that arm.
const literal = { kind: "tri", base: 4, name: "t", spare: true };
const stray: unknown = literal;
const fitted = stray as Shape;
console.log(fitted.kind === "tri" ? fitted.base : -1, fitted.name);

// A value that is none of the arms goes on to the other arms' tests.
const plain: unknown = JSON.parse('{"kind":"square","side":12,"name":"parsed"}');
const parsed = plain as Shape;
console.log(parsed.kind === "square" ? parsed.side : -1, JSON.stringify(parsed));
