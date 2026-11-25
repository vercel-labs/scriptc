// Record types that differ only in their literals share one layout, so a
// typed record's type alone does not say which arm of a discriminated union
// it is: the checked conversion takes a record of an arm's own type as that
// arm only when the record holds one of the arm's literals, which it reads
// from the record itself. A record of an arm's layout that carries another
// arm's literal is that other arm, as its literal says. Before, such a record
// was taken as the arm whose layout it has, and the first narrowing on its
// discriminant aborted.
type Small = { kind: "small"; x: number };
type Large = { kind: "large"; x: number; extra?: number };
type Other = { kind: "large"; x: number };
type Loose = { kind: string; x: number };

function show(v: Small | Large): string {
	if (v.kind === "large") return "large:" + v.x + ":" + String(v.extra);
	return "small:" + v.x;
}

// A record typed with another arm's literal, in the first arm's layout.
const other: Other = { kind: "large", x: 7 };
const heldOther: unknown = other;
const first = heldOther as Small | Large;
console.log("another arm's literal:", show(first), first.kind);
if (first.kind === "large") {
	first.extra = 3;
	console.log("its optional member:", show(first));
}

// A record typed with a plain string, holding each arm's literal in turn.
const loose: Loose[] = [
	{ kind: "large", x: 1 },
	{ kind: "small", x: 2 },
	{ kind: "large", x: 3 },
];
const heldLoose: unknown[] = loose;
for (const item of heldLoose) console.log("a string member:", show(item as Small | Large));

// A record that is the arm, literal included, is still the same object.
const small: Small = { kind: "small", x: 10 };
const heldSmall: unknown = small;
const same = heldSmall as Small | Large;
same.x = 11;
console.log("the arm itself, write seen by the record:", small.x);
small.x = 12;
console.log("the arm itself, record write seen:", same.x, show(same));

// Four literals and more: the arm is chosen from one read of the
// discriminant, and arms that share a layout share an arm.
type A1 = { kind: "a1"; x: number };
type A2 = { kind: "a2"; x: number };
type A3 = { kind: "a3"; x: number };
type B1 = { kind: "b1"; x: number; extra?: number };
type B2 = { kind: "b2"; x: number; extra?: number };
type Many = A1 | A2 | A3 | B1 | B2;
type AsB2 = { kind: "b2"; x: number };

function showMany(v: Many): string {
	switch (v.kind) {
		case "a1":
		case "a2":
		case "a3":
			return v.kind + ":" + v.x;
		case "b1":
		case "b2":
			return v.kind + ":" + v.x + ":" + String(v.extra);
	}
}

const asB2: AsB2 = { kind: "b2", x: 9 };
const a2: A2 = { kind: "a2", x: 1 };
const b1: B1 = { kind: "b1", x: 2, extra: 5 };
const heldMany: unknown[] = [asB2, a2, b1];
for (const item of heldMany) {
	const v = item as Many;
	console.log("many literals:", showMany(v));
	if (v.kind === "b1" || v.kind === "b2") {
		v.extra = (v.extra ?? 0) + 1;
		console.log("many literals, its optional member:", showMany(v));
	}
}
const sameA2 = heldMany[1] as Many;
sameA2.x = 21;
console.log("many literals, the arm itself:", a2.x);
const sameB1 = heldMany[2] as Many;
sameB1.x = 22;
console.log("many literals, the wider arm itself:", b1.x, b1.extra);

// Number and boolean discriminants.
type Zero = { tag: 0; x: number };
type One = { tag: 1; x: number; note?: string };
type AsOne = { tag: 1; x: number };
function showTag(v: Zero | One): string {
	return v.tag === 1 ? "one:" + v.x + ":" + String(v.note) : "zero:" + v.x;
}
const asOne: AsOne = { tag: 1, x: 4 };
const zero: Zero = { tag: 0, x: 5 };
const heldTags: unknown[] = [asOne, zero];
for (const item of heldTags) console.log("a number literal:", showTag(item as Zero | One));
const sameZero = heldTags[1] as Zero | One;
sameZero.x = 6;
console.log("a number literal, the arm itself:", zero.x);

type Off = { on: false; x: number };
type On = { on: true; x: number; level?: number };
type AsOn = { on: true; x: number };
function showOn(v: Off | On): string {
	return v.on ? "on:" + v.x + ":" + String(v.level) : "off:" + v.x;
}
const asOn: AsOn = { on: true, x: 7 };
const off: Off = { on: false, x: 8 };
const heldOn: unknown[] = [asOn, off];
for (const item of heldOn) console.log("a boolean literal:", showOn(item as Off | On));
const sameOff = heldOn[1] as Off | On;
sameOff.x = 9;
console.log("a boolean literal, the arm itself:", off.x);

// A class instance is none of the arms: its discriminant is read through
// its members, a field or a getter, by the arms' own tests.
type Dot = { kind: "dot"; x: number };
type Line = { kind: "line"; y: string };
type Ray = { kind: "ray"; y: string };
type Arc = { kind: "arc"; x: number };
class Field {
	kind: string;
	x = 1;
	y = "why";
	constructor(kind: string) {
		this.kind = kind;
	}
}
class Getter {
	x = 2;
	y = "how";
	private readonly answer: string;
	constructor(answer: string) {
		this.answer = answer;
	}
	get kind(): string {
		return this.answer;
	}
}
function showPair(v: Dot | Line): string {
	return v.kind === "dot" ? "dot:" + v.x : "line:" + v.y;
}
function showFour(v: Dot | Line | Ray | Arc): string {
	switch (v.kind) {
		case "dot":
		case "arc":
			return v.kind + ":" + v.x;
		case "line":
		case "ray":
			return v.kind + ":" + v.y;
	}
}
const instances: unknown[] = [new Field("dot"), new Field("line"), new Getter("dot"), new Getter("line")];
for (const item of instances) console.log("a class instance:", showPair(item as Dot | Line));
const more: unknown[] = [new Field("arc"), new Field("ray"), new Getter("arc"), new Getter("ray")];
for (const item of [...instances, ...more])
	console.log("a class instance, many literals:", showFour(item as Dot | Line | Ray | Arc));
