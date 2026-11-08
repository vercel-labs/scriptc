// A class constructor held as `unknown` answers for its static members the
// way the class does: a declared static reads its current value, a name the
// class does not have reads undefined, inherited statics come from the base
// class, `in`, Object.keys and descriptors see the statics, a write goes to
// the storage typed code reads, and `prototype` is the object the class's
// instances have as their prototype, with the methods on it.

class Exporter {
  static format: string = "text";
  static limits: { rows: number } = { rows: 40 };
  static readonly version: number = 3;
  static #made: number = 0;
  static create(title: string): Exporter {
    Exporter.#made++;
    return new Exporter(title, Exporter.#made);
  }
  static get made(): number {
    return Exporter.#made;
  }
  title: string;
  serial: number;
  constructor(title: string, serial: number) {
    this.title = title;
    this.serial = serial;
  }
  render(): string {
    return this.title + "#" + this.serial;
  }
}

class CsvExporter extends Exporter {
  static separator: string = ",";
  constructor(title: string) {
    super(title, 100);
  }
  render(): string {
    return "csv " + super.render();
  }
}

class Bare {
  size: number = 1;
}

function plain(): string {
  return "plain";
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}
function isFunctionRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "function";
}

function show(value: unknown): string {
  if (isRecord(value)) return "{" + Object.keys(value).join(",") + "}";
  if (typeof value === "function") return "function";
  return String(value);
}

const registry: Array<[string, unknown]> = [
  ["Exporter", Exporter],
  ["CsvExporter", CsvExporter],
  ["Bare", Bare],
  ["plain", plain],
];

const keys = ["name", "length", "format", "limits", "version", "separator", "create", "made", "absent"];
for (const [label, entry] of registry) {
  if (!isFunctionRecord(entry)) continue;
  console.log(label, typeof entry);
  for (const key of keys) console.log(" ", key, show(entry[key]), key in entry);
  console.log("  keys", Object.keys(entry).join(","));
  console.log("  own format", Object.hasOwn(entry, "format"), "own separator", Object.hasOwn(entry, "separator"));
}

// Named reads and a missing name.
function describe(entry: unknown): string {
  if (!isFunctionRecord(entry)) return "not a function";
  const separator = entry.separator;
  const fallback = entry.fallback;
  return String(entry.format) + "|" + String(separator) + "|" + String(fallback);
}
console.log(describe(Exporter), describe(CsvExporter), describe(Bare), describe(plain));

// The base class is the prototype of the subclass constructor.
function parentOf(entry: unknown): unknown {
  return isFunctionRecord(entry) ? Object.getPrototypeOf(entry) : undefined;
}
console.log(parentOf(CsvExporter) === Exporter, parentOf(CsvExporter) === CsvExporter);

// A write through the dynamic value is the write typed code sees, and the
// other way around.
function setFormat(entry: unknown, format: unknown): void {
  if (isFunctionRecord(entry)) entry.format = format;
}
setFormat(Exporter, "html");
console.log(Exporter.format, CsvExporter.format);
Exporter.format = "pdf";
console.log(describe(Exporter));

// A subclass write makes an own property of the subclass, as in JavaScript.
function addNote(entry: unknown, note: string): void {
  if (isFunctionRecord(entry)) entry.note = note;
}
addNote(CsvExporter, "wide");
console.log(describe(CsvExporter), Object.keys(CsvExporter as unknown as { [key: string]: unknown }).join(","));

// Descriptors: a static field is a data property.
function descriptorOf(entry: unknown, key: string): string {
  if (!isFunctionRecord(entry)) return "none";
  const descriptor: unknown = Object.getOwnPropertyDescriptor(entry, key);
  if (!isRecord(descriptor)) return String(descriptor);
  return Object.keys(descriptor).join(",") + " " + String(descriptor.writable) + " " + String(descriptor.enumerable);
}
console.log(descriptorOf(Exporter, "limits"));
console.log(descriptorOf(Exporter, "version"));
console.log(descriptorOf(Exporter, "create"));
console.log(descriptorOf(Exporter, "absent"));
console.log(descriptorOf(CsvExporter, "format"));

// A static method read as a value and called; the getter over a private static.
function make(entry: unknown, title: string): string {
  if (!isFunctionRecord(entry)) return "none";
  const create = entry.create;
  if (typeof create !== "function") return "no create";
  const made: unknown = create.call(entry, title);
  return isRecord(made) ? String(made.title) + " " + String(made.serial) + " " + String(entry.made) : "nothing";
}
console.log(make(Exporter, "first"), make(Exporter, "second"), make(Bare, "third"));
console.log(Exporter.create("typed").render(), Exporter.made);

// `prototype`: an object, the prototype of the instances, with the methods.
function prototypeOf(entry: unknown): unknown {
  return isFunctionRecord(entry) ? entry.prototype : undefined;
}
const csv = new CsvExporter("table");
const viewed: unknown = csv;
for (const [label, entry] of registry) {
  const prototype = prototypeOf(entry);
  if (!isRecord(prototype)) {
    console.log(label, "prototype", typeof prototype);
    continue;
  }
  const render = prototype.render;
  console.log(
    label,
    "prototype",
    typeof render,
    prototype.constructor === entry,
    Object.getPrototypeOf(viewed) === prototype,
    "render" in prototype,
    "absent" in prototype,
  );
  if (typeof render === "function") console.log(" ", render.call(viewed));
}

// Constructing through the dynamic value, and the instance through `unknown`.
type Constructible = { new (...args: Array<string | number>): { [key: string]: unknown }; readonly [key: string]: unknown };
function isConstructible(value: unknown): value is Constructible {
  return typeof value === "function" && isRecord(prototypeOf(value)) && "render" in (prototypeOf(value) as object);
}
for (const [label, entry] of registry) {
  if (!isConstructible(entry)) {
    console.log(label, "is not constructible here");
    continue;
  }
  const made = new entry("built", 9);
  const render = made.render;
  console.log(label, made.title, made.serial, typeof render === "function" ? render.call(made) : "none", "format" in entry);
}

// A class that never becomes a dynamic value keeps its statics as they were.
class Quiet {
  static level: number = 2;
  static raise(): number {
    return ++Quiet.level;
  }
}
console.log(Quiet.raise(), Quiet.level);
