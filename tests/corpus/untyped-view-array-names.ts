// A typed array seen through an untyped value: a read of a name the array
// does not hold (`then`, `toJSON`, a label) answers undefined, and the array
// stays one object for both sides: elements written through one side are read
// through the other. Names that do have an answer keep it: numeric names,
// a property added through the untyped side, the metadata of a match result,
// a member put on Array.prototype.
function say(label: string, value: unknown): void {
  console.log(label + ": " + String(value));
}
function get(u: any, key: string): unknown {
  return u[key];
}
function put(u: any, key: string, value: unknown): void {
  u[key] = value;
}

const names = ["then", "toJSON", "label", "$mark", "_private", "Infinity", "NaN", "-1", "1.5", "01", "7"];

{
  const typed: number[] = [1, 5];
  const loose: unknown = typed;
  for (const name of names) say("number[] " + name, get(loose, name));
  typed[0] = 2;
  typed.push(9);
  say("after typed writes", [get(loose, "0"), get(loose, "2"), get(loose, "length"), get(loose, "then")].join(" | "));
  put(loose, "1", 6);
  say("after loose write", [typed[1], typed.length, Array.isArray(loose), typeof loose].join(" | "));
  say("prototype", [Object.getPrototypeOf(loose) === Array.prototype, loose instanceof Error, get(loose, "then")].join(" | "));
}
{
  const typed: { level: number }[] = [{ level: 1 }, { level: 5 }];
  const loose: unknown = typed;
  say("records then", get(loose, "then"));
  const first: unknown = get(loose, "0");
  say("element missing", [get(first, "missing"), typeof first].join(" | "));
  typed[0]!.level = 3;
  say("element after typed write", get(first, "level"));
  put(first, "level", 4);
  say("element after loose write", typed[0]!.level);
  typed[0] = { level: 8 };
  say("replaced", [get(first, "level"), get(get(loose, "0"), "level"), JSON.stringify(loose)].join(" | "));
}
{
  const typed: string[][] = [["a"], ["b", "c"]];
  const loose: unknown = typed;
  const inner: unknown = get(loose, "1");
  say("nested then", [get(loose, "then"), get(inner, "then"), get(inner, "length")].join(" | "));
  typed[1]!.push("d");
  say("nested after push", [get(inner, "2"), get(inner, "length"), get(inner, "toJSON")].join(" | "));
}
{
  const typed: number[] = [1, 5];
  const loose: unknown = typed;
  say("label before", get(loose, "label"));
  put(loose, "label", "tagged");
  say("label after", [get(loose, "label"), get(loose, "then"), get(loose, "length")].join(" | "));
  typed.push(7);
  say("label after push", [get(loose, "label"), get(loose, "2")].join(" | "));
}
{
  const typed = /b(c)/.exec("abcd");
  const loose: unknown = typed;
  say("match", [get(loose, "then"), get(loose, "index"), get(loose, "input"), get(loose, "0"), get(loose, "1")].join(" | "));
}
{
  const typed: number[] = [1, 5];
  const loose: unknown = typed;
  say("extended before", get(loose, "extra"));
  (Array.prototype as any).extra = "from prototype";
  say("extended", [get(loose, "extra"), get(loose, "then")].join(" | "));
  delete (Array.prototype as any).extra;
  say("extended after delete", get(loose, "extra"));
}
