// A numeric enum used as a value has the object tsc's emit builds: each
// member name holding its value and each value's string form holding the
// member's name, enumerated the way Node orders own keys (array indices
// ascending, then the rest in creation order). `E[n]` with a runtime
// number is the reverse lookup and reads undefined for a value no member
// has.
enum Level {
  Low,
  High,
  Top = 10,
  Next,
  Mid = 5,
}

// A later member with the same value takes over the reverse entry in
// place; values that are not array indices keep their creation position.
enum Odd {
  A = 1,
  Alias = 1,
  Neg = -1,
  Half = 1.5,
  Big = 1e21,
  Tiny = 1e-7,
  Last = 4294967295,
  Index = 4294967294,
}

console.log(Object.keys(Level).join(","));
console.log(Object.values(Level).join(","));
console.log(JSON.stringify(Object.entries(Level)));
console.log(JSON.stringify(Level));
console.log(Level);
for (const key in Level) console.log("in", key);
console.log("Low" in Level, "0" in Level, "Missing" in Level, Object.hasOwn(Level, "10"));

console.log(Object.keys(Odd).join("|"));
console.log(JSON.stringify(Object.entries(Odd)));

// The reverse lookup through a runtime number.
function nameOf(value: number): string | undefined {
  return Level[value];
}
const values: number[] = [0, 1, 5, 10, 11, 2, -1, 0.5, NaN, Infinity, -0];
console.log(values.map((v) => String(nameOf(v))).join(","));
const picked: number = Number(process.argv[2] ?? "1");
console.log(Level[picked], Level[picked + 100], Odd[picked], Odd[-picked], Odd[picked + 0.5]);
const maybe = Level[picked * 7];
console.log(maybe === undefined, typeof maybe, typeof Level[picked]);

// The name of an enum-typed value.
function label(level: Level): string {
  return Level[level];
}
const levels: Level[] = [Level.Top, Level.Low, Level.Mid];
console.log(levels.map(label).join(","), label(Level.Next).toUpperCase(), `${Level[levels[0]!]}`);

// The idioms that separate names from values.
const names = Object.keys(Level).filter((key) => Number.isNaN(Number(key)));
const numbers = Object.values(Level).filter((value) => typeof value === "number");
console.log(names.join(","), numbers.join(","));
const total = Object.values(Level).reduce((sum: number, value) => (typeof value === "number" ? sum + value : sum), 0);
console.log(total, Object.keys(Level).length, Object.entries(Level).length);
