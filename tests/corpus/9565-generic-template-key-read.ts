// A generic function reads a member whose name is a template built from its
// type parameter (`rates[`rate-${zone}`]`), on a mapped type over that
// template intersected with other optional members. Every call passes a
// literal, so each instance's record lists the member its literal names.
// The member is read through a destructured parameter, the whole parameter,
// a local, with the key in a const and written in place; the other declared
// members share the mapped member's type in one tariff and not in the other.
interface Tariff<Zone extends string> {
  zone: Zone;
  rates: { [K in `rate-${Zone}`]?: number } & { express?: boolean; note?: string };
}

function quote<Zone extends string>({ zone, rates }: Tariff<Zone>): string {
  const key = `rate-${zone}` as const;
  const rate = rates[key];
  if (typeof rate === "number") return rates.express ? `${zone} express ${rate * 2}` : `${zone} ${rate}`;
  return rates.express ? `${zone} express only` : `${zone} none`;
}

console.log(quote({ zone: "north", rates: { "rate-north": 12 } }));
console.log(quote({ zone: "north", rates: { express: true } }));
console.log(quote({ zone: "coast", rates: { "rate-coast": 7, express: true } }));
console.log(quote({ zone: "north", rates: {} }));

function whole<Zone extends string>(tariff: Tariff<Zone>): string {
  const rate = tariff.rates[`rate-${tariff.zone}`];
  const rates = tariff.rates;
  const again = rates[`rate-${tariff.zone}` as const];
  return `${tariff.zone} ${String(rate)} ${String(again)} ${JSON.stringify(rates)} ${Object.keys(rates).join(",")}`;
}
console.log(whole({ zone: "north", rates: { "rate-north": 12, note: "n" } }));
console.log(whole({ zone: "coast", rates: { note: "c" } }));

// The other members have the mapped member's type: every member can answer
// a keyed read at one type.
interface Labels<Lang extends string> {
  lang: Lang;
  words: { [K in `word-${Lang}`]?: string } & { plural?: string; short?: string };
}

function word<Lang extends string>({ lang, words }: Labels<Lang>): string {
  const found = words[`word-${lang}` as const];
  return `${lang} ${typeof found === "string" ? found.toUpperCase() : "missing"} ${`word-${lang}` in words} ${JSON.stringify(words)}`;
}
console.log(word({ lang: "en", words: { "word-en": "box", plural: "boxes" } }));
console.log(word({ lang: "de", words: { short: "k" } }));

function viaLocal<Lang extends string>(labels: Labels<Lang>): string {
  const { lang, words } = labels;
  const key = `word-${lang}` as const;
  return `${lang} ${String(words[key])} ${String(words.plural)}`;
}
console.log(viaLocal({ lang: "en", words: { "word-en": "box", plural: "boxes" } }));

// The mapped member is required, and the parameter stands at the front.
interface Limits<Axis extends string> {
  axis: Axis;
  row: { [K in `${Axis}-max`]: number } & { strict?: boolean };
}
function ceiling<Axis extends string>({ axis, row }: Limits<Axis>): string {
  const found = row[`${axis}-max` as const];
  return `${axis} ${typeof found === "number" ? found + 1 : "none"} ${row.strict === true}`;
}
console.log(ceiling({ axis: "depth", row: { "depth-max": 40 } }));
console.log(ceiling({ axis: "width", row: { "width-max": 9, strict: true } }));

// The other members share the template's prefix and have their own types,
// so the key's text can spell any member: the read dispatches over all of
// them, and its value is used as whatever it turns out to be.
interface Headers<Name extends string> {
  name: Name;
  sent: { [K in `x-${Name}`]?: string } & { "x-debug"?: boolean; "x-trace"?: string };
}
function header<Name extends string>({ name, sent }: Headers<Name>): string {
  const key = `x-${name}` as const;
  const value = sent[key];
  const debug = sent["x-debug"];
  if (debug && value) return `debug ${key}`;
  if (typeof value === "string") return value.toLowerCase();
  return debug ? "debug only" : "none";
}
console.log(header({ name: "region", sent: { "x-region": "North" } }));
console.log(header({ name: "region", sent: { "x-debug": true } }));
console.log(header({ name: "trace", sent: { "x-trace": "T1", "x-debug": true } }));
console.log(header({ name: "region", sent: {} }));

// A parameter bound to two literals: the record lists both members.
const zones: ("north" | "coast")[] = ["north", "coast"];
for (const zone of zones) console.log(quote({ zone, rates: { "rate-north": 1, "rate-coast": 2 } }));
