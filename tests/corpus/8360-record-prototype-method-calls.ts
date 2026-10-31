// Object.prototype's methods called by name on typed records: the built-in
// with the record as its receiver, or an own entry that shadows it.
interface Point {
  x: number;
  y: number;
}
const counts: Record<string, number> = { apple: 2, pear: 0 };
const point: Point = { x: 1, y: 2 };
const handlers: Record<string, (n: number) => number> = { double: (n) => n * 2 };
const own: Record<string, () => string> = {
  toString: () => "own toString",
  valueOf: () => "own valueOf",
};

function line(...parts: unknown[]): void {
  console.log(parts.map(String).join(" | "));
}

line("toString", counts.toString(), point.toString(), handlers.toString(), String(counts));
line("toLocaleString", counts.toLocaleString(), point.toLocaleString());
line("valueOf", counts.valueOf() === counts, point.valueOf() === point);
line(
  "hasOwnProperty",
  counts.hasOwnProperty("apple"),
  counts.hasOwnProperty("pear"),
  counts.hasOwnProperty("plum"),
  counts.hasOwnProperty("toString"),
  point.hasOwnProperty("x"),
  point.hasOwnProperty("z"),
  handlers.hasOwnProperty("double"),
  handlers.hasOwnProperty("valueOf"),
);
line("propertyIsEnumerable", counts.propertyIsEnumerable("apple"), point.propertyIsEnumerable("toString"));
line("isPrototypeOf", counts.isPrototypeOf(point), point.isPrototypeOf(counts));

// Own entries shadow the built-ins; toLocaleString calls the own toString.
line("own", own.toString(), own.toLocaleString(), own.valueOf(), own.hasOwnProperty("toString"));
delete own["toString"];
line("own deleted", own.toString(), own.toLocaleString());
own.toString = () => "own again";
line("own again", own.toString(), `${String(own.toString())}`);

// Keys added at run time are own keys too.
const later: Record<string, number> = {};
for (const word of "toString valueOf plain toString".split(" ")) {
  later[word] = (later.hasOwnProperty(word) ? later[word]! : 0) + 1;
}
line("later", JSON.stringify(later), later.hasOwnProperty("toString"), later.hasOwnProperty("constructor"));

// A null-prototype record has no inherited methods.
const groups = Object.groupBy([1, 2, 3], (n): string => (n % 2 ? "odd" : "even"));
try {
  line("groups", groups.toString());
} catch (e) {
  line("groups threw", (e as Error).name + ": " + (e as Error).message);
}
