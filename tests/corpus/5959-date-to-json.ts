// Date.prototype.toJSON answers the toISOString() string for a valid date
// and null for an invalid one (the lib types say string), through
// bindings, literals, JSON.stringify and console.log.
const good = new Date(Date.UTC(2024, 1, 29, 12, 30, 15, 250));
const bad = new Date("not a date");
const epoch = new Date(0);

console.log(good.toJSON(), bad.toJSON(), epoch.toJSON("ignored key"));
console.log(JSON.stringify(good.toJSON()), JSON.stringify(bad.toJSON()));

const kept = bad.toJSON();
const shown = good.toJSON();
console.log(kept, shown, kept === null, typeof kept, kept ?? "fallback");
console.log(`${bad.toJSON()} / ${good.toJSON()}`);

const annotated: string | null = bad.toJSON();
console.log(annotated, JSON.stringify({ annotated }));

let changing: string | null = "start";
changing = bad.toJSON();
console.log(changing === null, JSON.stringify([changing, epoch.toJSON()]));

const record = { at: good.toJSON(), never: bad.toJSON(), kept };
console.log(JSON.stringify(record), record.never === null, record.at);
console.log(JSON.stringify({ direct: bad.toJSON(), also: epoch.toJSON() }));
console.log(JSON.stringify([bad.toJSON(), good.toJSON(), shown]));

function stamp(date: Date): string {
  const text = date.toJSON();
  return text === null ? "invalid" : text.slice(0, 10);
}
console.log(stamp(good), stamp(bad), stamp(epoch));
