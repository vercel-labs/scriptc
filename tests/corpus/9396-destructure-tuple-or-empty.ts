// Pins: an array destructuring whose source falls back to an empty array
// literal, `const [a, b] = table[key] ?? []`. The pattern reads either the
// tuple's positions or, from the empty array, undefined for every position.
// A unit converts by a factor into a base unit; an unknown unit has no row.
const scales: Record<string, [factor: number, unit: string]> = {
  inch: [25.4, "mm"],
  mile: [1609.344, "m"],
  ounce: [28.3495, "g"],
};

function convert(amount: number, name: string): string {
  const [factor, unit] = scales[name] ?? [];
  const converted = factor === undefined ? "?" : (amount * factor).toFixed(1);
  return `${amount} ${name} = ${converted} ${unit ?? "(no such unit)"}`;
}
for (const name of ["inch", "ounce", "cubit", "mile"]) console.log(convert(2, name));

// A function nothing calls takes the same lowering: the build must not depend on it.
function precision(name: string): number {
  const [factor] = scales[name] ?? [];
  return factor === undefined ? 0 : String(factor).length;
}

// Other operands that can be absent, and other spellings of the fallback.
const spans = new Map<string, [number, number]>([["octave", [220, 440]]]);
function span(name: string): string {
  const [low, high] = spans.get(name) ?? [];
  return `${low === undefined ? "?" : low}..${high === undefined ? "?" : high}`;
}
console.log(span("octave"), span("fifth"));

function either(point: [string, number] | undefined): string {
  const [axis, value] = point || [];
  return `${axis} ${value} ${typeof axis} ${typeof value}`;
}
console.log(either(["x", 1]), "|", either(undefined));

function chosen(point: [string, number] | null): string {
  const [axis, value] = point ? point : [];
  return `${axis} ${value}`;
}
function chosenFirst(point: [string, number] | undefined): string {
  const [axis, value] = point === undefined ? [] : point;
  return `${axis} ${value}`;
}
console.log(chosen(["y", 2]), "|", chosen(null), "|", chosenFirst(["z", 3]), "|", chosenFirst(undefined));

// Defaults in the pattern apply where the position is undefined.
function withDefaults(point: [string, number] | undefined): string {
  const [axis = "origin", value = 0] = point ?? [];
  return `${axis}:${value + 1}`;
}
console.log(withDefaults(["w", 4]), withDefaults(undefined));

// Fewer bindings than positions, a hole, and three positions of three types.
function firstOnly(shape: { corner?: [string, number] }): string {
  const [axis] = shape.corner ?? [];
  return String(axis);
}
function secondOnly(shape: { corner?: [string, number] }): string {
  const [, value] = shape.corner ?? [];
  return String(value);
}
function triple(pixel: [string, number, boolean] | undefined): string {
  const [channel, level, lit] = pixel ?? [];
  return [channel, level, lit].map((part) => String(part)).join(",");
}
console.log(firstOnly({ corner: ["u", 5] }), firstOnly({}), secondOnly({ corner: ["v", 6] }), secondOnly({}));
console.log(triple(["red", 7, true]), triple(undefined));

// The operand is evaluated once, and only when the fallback's operator reaches it.
let lookups = 0;
function find(name: string): [number, string] | undefined {
  lookups++;
  return scales[name];
}
const [one, two] = find("mile") ?? [];
const [none] = find("league") ?? [];
console.log(one, two, none, lookups);

// `let` bindings can be assigned afterwards.
function later(point: [string, number] | undefined): string {
  let [axis, value] = point ?? [];
  if (axis === undefined) axis = "late";
  if (value === undefined) value = -1;
  return `${axis}/${value}`;
}
console.log(later(["t", 8]), later(undefined));
