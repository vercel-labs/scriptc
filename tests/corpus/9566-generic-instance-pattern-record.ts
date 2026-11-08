// Inside a generic function the names of a destructured parameter are typed
// from the declared parameter type, which still mentions the type
// parameter; the value is the record the call's own signature gave. A
// member the declared type holds only through the type parameter (a mapped
// type over a template of it) is in the value and must stay readable
// through the names: here every member has one type, so a keyed read
// answers any of them.
interface Labels<Lang extends string> {
  lang: Lang;
  words: { [K in `word-${Lang}`]?: string } & { plural?: string; short?: string };
}

function fromParameter<Lang extends string>({ lang, words }: Labels<Lang>): string {
  const found = words[`word-${lang}` as const];
  return `${lang} ${typeof found === "string" ? found : "missing"} ${JSON.stringify(words)}`;
}

function fromLocal<Lang extends string>(labels: Labels<Lang>): string {
  const { lang, words } = labels;
  const found = words[`word-${lang}` as const];
  return `${lang} ${typeof found === "string" ? found : "missing"} ${Object.keys(words).join(",")}`;
}

// The same through a local that names the record, with the type parameter
// at the front of the template.
interface Limits<Axis extends string> {
  axis: Axis;
  row: { [K in `${Axis}-max`]?: number } & { floor?: number };
}

function fromAlias<Axis extends string>(limits: Limits<Axis>): string {
  const row = limits.row;
  const found = row[`${limits.axis}-max` as const];
  return `${limits.axis} ${typeof found === "number" ? found + 1 : "missing"} ${JSON.stringify(row)}`;
}

console.log(fromParameter({ lang: "en", words: { "word-en": "box", plural: "boxes" } }));
console.log(fromParameter({ lang: "de", words: { short: "k" } }));
console.log(fromLocal({ lang: "en", words: { "word-en": "box", short: "b" } }));
console.log(fromAlias({ axis: "depth", row: { "depth-max": 40 } }));
console.log(fromAlias({ axis: "width", row: { "width-max": 9, floor: 1 } }));
