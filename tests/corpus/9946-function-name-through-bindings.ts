// A function's `name` belongs to the function, not to the place it is read
// from: a unit converter keeps its name when it is read through a parameter,
// a record field, a class field, an array element, a Map, a returned value,
// an `unknown` value or a binding that is assigned again, and after
// Object.defineProperty and Object.defineProperties added properties to it.
// A `name` the program defines on the function answers every later read.
export {};

type Convert = (value: number) => number;

function toFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

const toKelvin = (celsius: number): number => celsius + 273.15;

const toRankine = function rankine(celsius: number): number {
  return ((celsius + 273.15) * 9) / 5;
};

// Named by an assignment after the declaration, and by a parameter default.
let toDelisle: Convert;
toDelisle = (celsius: number): number => ((100 - celsius) * 3) / 2;

let current: Convert = (celsius: number): number => celsius;
current = function replaced(celsius: number): number {
  return celsius + 1;
};

function offsetBy(offset: number): Convert {
  return (celsius: number): number => celsius + offset;
}

function scaledBy(factor: number): Convert {
  const scale = (celsius: number): number => celsius * factor;
  return scale;
}

function nameOf(convert: Convert): string {
  return convert.name;
}

function nameOrDefault(convert: Convert = (celsius: number): number => celsius): string {
  return convert.name;
}

function nameOfGeneric<T extends (...args: never[]) => unknown>(convert: T): string {
  return convert.name;
}

// A function chosen at run time: its name is known only then.
function chosen(metric: boolean): Convert {
  return metric ? toKelvin : toFahrenheit;
}

function nameOfUnknown(value: unknown): string {
  return typeof value === "function" ? value.name : "not a function";
}

function nameOfOptional(convert: Convert | undefined): string {
  return convert === undefined ? "none" : convert.name;
}

function pass<T>(value: T): T {
  return value;
}

function tagged<T extends object>(target: T): T {
  return Object.defineProperties(target, { unit: { value: "degree" } });
}

function show(convert: Convert): void {
  console.log(convert);
}

class Station {
  readonly convert: Convert;
  constructor(convert: Convert) {
    this.convert = convert;
  }
  label(): string {
    return "station:" + this.convert.name;
  }
}

const table = { fahrenheit: toFahrenheit, kelvin: toKelvin, shift: offsetBy(1) };
const list: Convert[] = [toFahrenheit, toKelvin, toRankine, toDelisle, current];
const byUnit = new Map<string, Convert>([
  ["F", toFahrenheit],
  ["K", toKelvin],
]);

console.log("direct", toFahrenheit.name, toKelvin.name, toRankine.name, toDelisle.name, current.name);
console.log("parameter", nameOf(toFahrenheit), nameOf(toKelvin), nameOf(toRankine), nameOf(toDelisle), nameOf(current));
console.log("closures", JSON.stringify(nameOf(offsetBy(2))), nameOf(scaledBy(2)), JSON.stringify(nameOf((celsius) => celsius)));
console.log("default", nameOrDefault(), nameOrDefault(toKelvin));
console.log("generic", nameOfGeneric(toFahrenheit), nameOfGeneric(toKelvin), pass(toRankine).name);
console.log("chosen", nameOfGeneric(chosen(true)), nameOfGeneric(chosen(false)), chosen(true).name);
console.log("unknown", nameOfUnknown(toFahrenheit), nameOfUnknown(toKelvin), nameOfUnknown(7));
console.log("optional", nameOfOptional(toKelvin), nameOfOptional(undefined));
console.log("field", table.fahrenheit.name, table.kelvin.name, JSON.stringify(table.shift.name));
console.log("class field", new Station(toFahrenheit).label(), new Station(toKelvin).convert.name);
console.log("element", list.map((convert) => convert.name).join(","), list[1]!.name);
console.log("map", byUnit.get("F")!.name, byUnit.get("K")!.name);
show(toFahrenheit);
show(toKelvin);
show(offsetBy(3));

// Properties added to a function do not change its name, whatever binding
// the function is held in when they are added.
const marked = tagged(toFahrenheit);
console.log("tagged", toFahrenheit.name, marked.name, marked === toFahrenheit, marked(100));
const descriptor = Object.getOwnPropertyDescriptor(marked, "name");
console.log("descriptor", descriptor?.value, descriptor?.writable, descriptor?.enumerable, descriptor?.configurable);

// A defined `name` is the function's name from then on.
function rename(target: Convert, to: string): void {
  Object.defineProperty(target, "name", { value: to });
}
rename(toKelvin, "absolute");
console.log("renamed", toKelvin.name, nameOf(toKelvin), table.kelvin.name, list[1]!.name, nameOfGeneric(toKelvin));
show(toKelvin);
