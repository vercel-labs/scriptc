// The enum object is an ordinary object: it can be stored, passed to
// typed, generic and untyped code, copied, destructured and compared.
enum Level {
  Low,
  High,
}
enum Tone {
  Hi = "hi",
  Lo = "lo",
}

function keysOf(table: Record<string, string | number>): string[] {
  return Object.keys(table);
}
function valuesOf<T extends Record<string, string | number>>(table: T): (string | number)[] {
  return Object.values(table);
}
function namesOf<T extends object>(table: T): (keyof T)[] {
  return Object.keys(table) as (keyof T)[];
}
function describe(value: object): string {
  return JSON.stringify(Object.entries(value));
}
function untyped(value: unknown): string {
  return typeof value + ":" + JSON.stringify(value);
}
// What a schema library does with an enum: the non-numeric own names.
function literals(item: any): string {
  return Object.getOwnPropertyNames(item)
    .filter((key) => isNaN(key as any))
    .map((key) => item[key])
    .join("|");
}

console.log(keysOf(Level).join(","), keysOf(Tone).join(","));
console.log(valuesOf(Level).join(","), valuesOf(Tone).join(","), namesOf(Tone).join(","));
console.log(describe(Level), describe(Tone));
console.log(untyped(Level), untyped(Tone));
console.log(literals(Level), literals(Tone));

const stored = Level;
const alias: typeof Tone = Tone;
console.log(stored === Level, alias === Tone, stored.High, alias.Lo, typeof stored);
console.log(Object.keys(stored).join(","), Object.values(alias).join(","));

const { Low, High } = Level;
const copy = { ...Tone };
const wrapped = { Level, tone: Tone };
console.log(Low, High, JSON.stringify(copy), JSON.stringify(wrapped));
console.log(Object.keys(wrapped.Level).join(","), wrapped.tone === Tone);

class Options {
  static readonly levels = Level;
  readonly tones = Tone;
  names(): string[] {
    return Object.keys(this.tones);
  }
}
console.log(Object.keys(Options.levels).join(","), new Options().names().join(","));

const tables: (typeof Level | typeof Tone)[] = [Level, Tone];
console.log(tables.length, tables[0] === Level, tables[1] === Tone);

// Typed lookups by a member name.
function levelOf(name: keyof typeof Level): Level {
  return Level[name];
}
console.log(levelOf("High"), (Object.keys(Tone) as (keyof typeof Tone)[]).map((name) => Tone[name]).join(","));
