// An option table whose members are CONSTRUCTORS used as type tags (the
// `arg` convention): String, Boolean and Number held in records, arrays,
// tuples, Maps, parameters, results and a union with strings and arrays.
// Each is the one function Node has: identity with the global and across
// holders, calls with any argument and with none, name, length, typeof,
// Array.isArray, Map and Set membership.
type Ctor = typeof Number | typeof String | typeof Boolean;
type Entry = Ctor | readonly Ctor[] | string;

const spec: Record<string, Entry> = {
  "--help": Boolean,
  "--name": String,
  "--port": Number,
  "--tag": [String],
  "-h": "--help",
};

for (const [key, entry] of Object.entries(spec)) {
  if (typeof entry === "string") {
    console.log(key, "alias of", entry);
    continue;
  }
  const list = Array.isArray(entry);
  const type = (Array.isArray(entry) ? entry[0] : entry) as Ctor;
  console.log(
    key,
    list,
    typeof type,
    type.name,
    type.length,
    type === Boolean,
    type === String,
    type === Number,
    JSON.stringify(type("42")),
  );
}

// One constructor type: calls take what the constructor takes.
const text = String;
const count: typeof Number = Number;
const flag = { type: Boolean };
console.log(text(12), text(true), text(null), text(undefined), JSON.stringify(text()));
console.log(count("0x10"), count(true), count(null), count(undefined), count(), count(" 7 "));
console.log(flag.type(""), flag.type("no"), flag.type(0), flag.type(), flag.type({}));
console.log(text.name, count.name, flag.type.name, text.length, count.length, flag.type.length);
console.log(String(text), String(count), String(flag.type));

// Identity across holders, through unknown and through a function type.
function tagOf(type: Ctor): string {
  return type === String ? "string" : type === Number ? "number" : "boolean";
}
function pick(index: number): Ctor {
  const all: Ctor[] = [String, Number, Boolean];
  return all[index]!;
}
const loose: unknown = Number;
const narrow = (value: string): unknown => value;
function same(fn: (value: string) => unknown): string {
  return [fn === String, fn === Number, fn === narrow, typeof fn("5")].join(" ");
}
console.log(tagOf(String), tagOf(pick(1)), tagOf(flag.type), pick(0) === text, pick(1) === count);
console.log(loose === Number, loose === String, typeof loose, same(String), same(Number), same(narrow));

// Keys of a Map and members of a Set, and a tuple that pairs a constructor
// with its default.
const labels = new Map<unknown, string>();
labels.set(String, "text");
labels.set(Number, "amount");
const seen = new Set<unknown>([Boolean, Number, Boolean]);
const pair: [typeof Number, string] = [Number, "0"];
console.log(labels.get(text), labels.get(count), labels.size, seen.has(Boolean), seen.has(String), seen.size);
console.log(pair[0](pair[1]), pair[0] === Number, Array.isArray(pair[0]), Array.isArray(spec["--tag"]));
