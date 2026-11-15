// Pins: a generic function that fills a string-keyed dictionary key by key
// and returns it through an assertion to its declared result type, a mapped
// type computed from its type parameters. Inside the instance the checker
// keeps that type symbolic; the returned dictionary takes the instance's
// result type and converts checked at the return. The object keeps every
// key the function wrote, in the order it wrote them, including keys the
// declared type does not name.

// The intersection with `{}` reduces to the bare mapped type, so the
// declared result and the asserted type are one type with no alias.
type Counts<Label extends string> = { [L in Label]: number } & {};

// A histogram over known labels; a sample outside them adds its own key.
function tally<Label extends string>(
  labels: readonly Label[],
  samples: readonly string[],
): Counts<Label> {
  const counts: Record<string, number> = {};
  for (const label of labels) counts[label] = 0;
  for (const sample of samples) counts[sample] = (counts[sample] ?? 0) + 1;
  return counts as Counts<Label>;
}

const weather = tally(["sun", "rain", "fog"] as const, ["rain", "sun", "rain", "hail", "rain"]);
const coins = tally(["tails", "heads"] as const, ["heads", "heads", "tails"]);

// Members read through the declared type.
console.log(weather.sun, weather.rain, weather.fog, coins.heads, coins.tails);

// The object's own keys in the order they were written, the undeclared one included.
console.log(Object.keys(weather).join(" "), "|", Object.keys(coins).join(" "));
console.log(JSON.stringify(weather), JSON.stringify(coins));
console.log(Object.values(weather).join(","));
for (const [label, count] of Object.entries(coins)) console.log(label, "x", count);
for (const label in weather) console.log("label", label);
console.log("rain" in weather, "hail" in weather, "snow" in weather);
console.log(weather);

// Back into a dictionary by a spread, alone and merged with another result.
function sum(bag: Record<string, number>): string {
  let total = 0;
  for (const key of Object.keys(bag)) total += bag[key]!;
  return `${Object.keys(bag).join("+")}=${total}`;
}
console.log(sum({ ...weather }));
console.log(sum({ ...coins, edge: 1 }));
console.log(sum({ ...weather, ...coins }));
const widened = { ...coins, dropped: 2 };
console.log(Object.keys(widened).join(" "), widened.heads, widened.dropped);

// A key remapped by a template: one member per room and kind of a sensor list.
interface Sensor {
  readonly room: string;
  readonly kind: "temp" | "light";
  readonly offset: number;
}
type Readings<S extends Sensor> = { [P in S as `${P["room"]}/${P["kind"]}`]: number } & {};

function calibrate<T extends ReadonlyArray<Sensor>>(sensors: T, raw: number): Readings<T[number]> {
  const readings: Record<string, number> = {};
  for (const sensor of sensors) readings[`${sensor.room}/${sensor.kind}`] = raw + sensor.offset;
  return readings as Readings<T[number]>;
}
const house = calibrate(
  [
    { room: "attic", kind: "temp", offset: -2 },
    { room: "hall", kind: "light", offset: 5 },
    { room: "attic", kind: "light", offset: 1 },
  ] as const,
  20,
);
console.log(house["attic/temp"], house["hall/light"], house["attic/light"]);
console.log(Object.keys(house).join(" "), JSON.stringify(house));

// Text values, and the result type inferred from the returned assertion.
type Labels<Code extends string> = { [C in Code]: string } & {};
function spell<Code extends string>(codes: readonly Code[]) {
  const labels: Record<string, string> = {};
  for (const code of codes) labels[code] = code.split("").reverse().join("");
  return labels as Labels<Code>;
}
const spelled = spell(["abc", "xy"] as const);
console.log(spelled.abc, spelled.xy, Object.keys(spelled).join(" "));

// Through `unknown`, from an arrow function, a method and a static method.
function viaUnknown<Label extends string>(labels: readonly Label[]): Counts<Label> {
  const counts: Record<string, number> = {};
  let next = labels.length;
  for (const label of labels) counts[label] = next--;
  return counts as unknown as Counts<Label>;
}
const rank = <Label extends string>(labels: readonly Label[]): Counts<Label> => {
  const counts: Record<string, number> = {};
  for (let index = 0; index < labels.length; index++) counts[labels[index]!] = index + 1;
  return counts as Counts<Label>;
};
class Ledger {
  private readonly opening: number;
  constructor(opening: number) {
    this.opening = opening;
  }
  open<Label extends string>(accounts: readonly Label[]): Counts<Label> {
    const balances: Record<string, number> = {};
    for (const account of accounts) balances[account] = this.opening;
    balances["suspense"] = 0;
    return balances as Counts<Label>;
  }
  static empty<Label extends string>(accounts: readonly Label[]): Counts<Label> {
    const balances: Record<string, number> = {};
    for (const account of accounts) balances[account] = 0;
    return balances as Counts<Label>;
  }
}
console.log(JSON.stringify(viaUnknown(["gold", "silver", "bronze"] as const)));
console.log(JSON.stringify(rank(["first", "second"] as const)));
console.log(JSON.stringify(new Ledger(100).open(["cash", "bank"] as const)));
console.log(Ledger.empty(["cash"] as const).cash, Object.keys(Ledger.empty(["a", "b"] as const)).length);

// One builder, several key sets: each instance has its own result type.
const zyx = tally(["z", "y", "x"] as const, ["x"]);
const xyz = tally(["x", "y", "z"] as const, ["x"]);
console.log(zyx.x, Object.keys(zyx).join(""), Object.keys(xyz).join(""), JSON.stringify(xyz));

// An early return beside the last one.
function clamp<Label extends string>(labels: readonly Label[], limit: number): Counts<Label> {
  const counts: Record<string, number> = {};
  if (limit < 0) return counts as Counts<Label>;
  for (const label of labels) counts[label] = Math.min(label.length, limit);
  return counts as Counts<Label>;
}
console.log(JSON.stringify(clamp(["short", "longer"] as const, 5)));

// An async builder settles with the record.
async function fetched<Code extends string>(codes: readonly Code[]): Promise<Labels<Code>> {
  const labels: Record<string, string> = {};
  for (const code of codes) labels[code] = await Promise.resolve(code.toUpperCase());
  return labels as Labels<Code>;
}
fetched(["q", "p"] as const).then((done) => {
  console.log(done.p, done.q, Object.keys(done).join(" "));
});
