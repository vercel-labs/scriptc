// A typed record seen through an untyped value: a question that only reads
// (a member the record does not have, a symbol member, instanceof Error, the
// prototype, `in`, a key walk, typeof, isArray, hasOwnProperty) must leave
// both sides looking at one object. After each question the record is
// written through one side and read through the other, both ways.
type Reading = { level: number; note?: string };
type Station = { name: string; reading: Reading };

function say(label: string, value: unknown): void {
  console.log(label + ": " + String(value));
}
function get(u: any, key: string): unknown {
  return u[key];
}
function put(u: any, key: string, value: unknown): void {
  u[key] = value;
}
function keysOf(t: any): string {
  const names: string[] = [];
  for (const name in t) names.push(name);
  return names.join(",");
}

const mark = Symbol("mark");
const questions: [string, (t: any) => string][] = [
  ["none", () => "-"],
  ["absent", (t) => String(t.missing)],
  ["optional", (t) => String(t.note)],
  ["then", (t) => typeof t.then],
  ["toJSON", (t) => typeof t.toJSON],
  ["iterator", (t) => typeof t[Symbol.iterator]],
  ["own symbol", (t) => String(t[mark])],
  ["error", (t) => String(t instanceof Error)],
  ["prototype", (t) => String(Object.getPrototypeOf(t) === Object.prototype)],
  ["in", (t) => String("missing" in t) + "," + String("level" in t)],
  ["walk", (t) => keysOf(t)],
  ["typeof", (t) => typeof t],
  ["isArray", (t) => String(Array.isArray(t))],
  ["hasOwn", (t) => String(Object.prototype.hasOwnProperty.call(t, "level")) + "," + String(Object.prototype.hasOwnProperty.call(t, "missing"))],
  ["keys", (t) => Object.keys(t).join(",")],
  ["absent then typeof", (t) => String(t.missing) + "," + typeof t + "," + String(Array.isArray(t))],
];

for (const [name, ask] of questions) {
  const typed: Reading = { level: 1 };
  const loose: unknown = typed;
  const first = ask(loose);
  typed.level = 2;
  const afterTyped = String(get(loose, "level"));
  put(loose, "level", 3);
  const afterLoose = String(typed.level);
  typed.note = "typed";
  const noteLoose = String(get(loose, "note"));
  put(loose, "note", "loose");
  say(name, [first, afterTyped, afterLoose, noteLoose, typed.note, ask(loose), JSON.stringify(typed), JSON.stringify(loose)].join(" | "));
}

for (const [name, ask] of questions) {
  const typed: Station = { name: "north", reading: { level: 1 } };
  const loose: unknown = typed;
  const inner: unknown = get(loose, "reading");
  const first = ask(inner);
  typed.reading.level = 2;
  const afterTyped = String(get(inner, "level"));
  put(inner, "level", 3);
  const afterLoose = String(typed.reading.level);
  typed.reading = { level: 8, note: "new" };
  say("nested " + name, [first, afterTyped, afterLoose, String(get(inner, "level")), String(get(get(loose, "reading"), "note")), ask(get(loose, "reading")), JSON.stringify(loose)].join(" | "));
}

// Members an ordinary object answers from elsewhere, and a view that holds
// more than the record: a member added through the untyped side, a getter,
// a prototype.
{
  const typed: Reading = { level: 1 };
  const loose: unknown = typed;
  say("before", [String(get(loose, "extra")), String(get(loose, "inherited")), String(get(loose, "computed"))].join(" | "));
  put(loose, "extra", "set");
  say("added", [String(get(loose, "extra")), String(get(loose, "missing")), keysOf(loose)].join(" | "));
  Object.defineProperty(loose as object, "computed", { get() { return "got"; }, enumerable: false, configurable: true });
  say("getter", [String(get(loose, "computed")), String(get(loose, "missing")), keysOf(loose)].join(" | "));
  Object.setPrototypeOf(loose as object, { inherited: "from prototype" });
  say("prototype", [String(get(loose, "inherited")), String(get(loose, "missing")), String(Object.getPrototypeOf(loose) === Object.prototype)].join(" | "));
  typed.level = 6;
  say("level", [String(get(loose, "level")), String(typed.level)].join(" | "));
}
{
  const typed: Reading = { level: 1, note: "n" };
  const loose: unknown = typed;
  say("optional present", String(get(loose, "note")));
  delete typed.note;
  say("optional deleted", [String(get(loose, "note")), String("note" in (loose as object)), keysOf(loose)].join(" | "));
  typed.note = "again";
  say("optional again", [String(get(loose, "note")), keysOf(loose)].join(" | "));
}
{
  const typed: Reading = { level: 1 };
  const loose: unknown = typed;
  const again: unknown = typed;
  say("missing", String(get(loose, "missing")));
  const seen = new Set<unknown>([loose]);
  say("identity", [String(loose === again), String(seen.has(again))].join(" | "));
}
