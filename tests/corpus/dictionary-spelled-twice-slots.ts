// The second spelling of a dictionary type in each kind of slot a value
// passes through: a parameter and a result, a class field, a record field,
// an array element, a Map value, and an arm of a union.
function show(same: boolean, held: object, source: object, value: unknown): void {
  console.log(same, Object.keys(held).join(","), Object.keys(source).join(","), JSON.stringify(value));
}

function touch(bag: { [key: string]: { param: number } }): { [key: string]: { param: number } } {
  bag.third = { param: 3 };
  return bag;
}
const paramSource = { first: { param: 1 } };
const paramHeld: { [key: string]: { param: number } } = paramSource;
paramHeld.second = { param: 2 };
const paramAgain = touch(paramHeld);
show(paramAgain === paramHeld, paramHeld, paramSource, paramAgain);

class Holder {
  held: { [key: string]: { field: number } } = {};
}
const fieldSource = { first: { field: 1 } };
const fieldHeld: { [key: string]: { field: number } } = fieldSource;
fieldHeld.second = { field: 2 };
const holder = new Holder();
holder.held = fieldHeld;
holder.held.third = { field: 3 };
show(holder.held === fieldHeld, fieldHeld, fieldSource, holder.held);

interface Settings {
  name: string;
  options: { [key: string]: { option: number } };
}
const optionSource = { first: { option: 1 } };
const optionHeld: { [key: string]: { option: number } } = optionSource;
optionHeld.second = { option: 2 };
const settings: Settings = { name: "s", options: optionHeld };
settings.options.third = { option: 3 };
show(settings.options === optionHeld, optionHeld, optionSource, settings);

const elementSource = { first: { element: 1 } };
const elementHeld: { [key: string]: { element: number } } = elementSource;
elementHeld.second = { element: 2 };
const elements: { [key: string]: { element: number } }[] = [];
elements.push(elementHeld);
elements[0]!.third = { element: 3 };
show(elements[0] === elementHeld, elementHeld, elementSource, elements);

const entrySource = { first: { entry: 1 } };
const entryHeld: { [key: string]: { entry: number } } = entrySource;
entryHeld.second = { entry: 2 };
const entries = new Map<string, { [key: string]: { entry: number } }>();
entries.set("only", entryHeld);
const entryAgain = entries.get("only");
if (entryAgain !== undefined) entryAgain.third = { entry: 3 };
show(entryAgain === entryHeld, entryHeld, entrySource, [...entries.keys()]);

const armSource = { first: { arm: 1 } };
const armHeld: { [key: string]: { arm: number } } = armSource;
armHeld.second = { arm: 2 };
const armAgain: null | { [key: string]: { arm: number } } = armHeld;
if (armAgain !== null) armAgain.third = { arm: 3 };
show(armAgain === armHeld, armHeld, armSource, armAgain);

// A recursive union alias whose dictionary arm is spelled again in an
// annotation: the dictionary of dictionaries of the union.
type Outer = null | string | { [key: string]: { [key: string]: Outer } };
const outerSource = { first: { a: "x" } };
const outerHeld: { [key: string]: { [key: string]: Outer } } = outerSource;
outerHeld.second = { b: null };
const outerAgain: Outer = outerHeld;
if (outerAgain !== null && typeof outerAgain === "object") outerAgain.third = { c: "late" };
show(outerAgain === outerHeld, outerHeld, outerSource, outerAgain);

// A JSON value type: the dictionary arm of the union, and the annotation.
type Json = number | Json[] | { [key: string]: Json };
const jsonSource = { first: 1 };
const jsonHeld: { [key: string]: Json } = jsonSource;
jsonHeld.second = [2, { deep: 3 }];
const jsonAgain: Json = jsonHeld;
if (typeof jsonAgain === "object" && !Array.isArray(jsonAgain)) jsonAgain.third = 3;
show(jsonAgain === jsonHeld, jsonHeld, jsonSource, jsonAgain);
