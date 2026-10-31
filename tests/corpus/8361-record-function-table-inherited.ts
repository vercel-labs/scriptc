// Records of functions used as dispatch tables meet Object.prototype's method
// names: a keyed read answers the inherited method, bound to the record when
// the read is called at once and a plain function value otherwise.
type Command = (arg: string) => unknown;
const commands: Record<string, Command> = {
  echo: (arg) => arg,
  shout: (arg) => arg.toUpperCase(),
};
const inputs = process.argv.length > 99 ? [] : ["echo", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "shout", "nope"];
function show(v: unknown): string {
  return v === commands ? "<commands>" : typeof v + ":" + String(v);
}
for (const name of inputs) {
  const handler = commands[name];
  if (!handler) {
    console.log(name, "unknown handler");
    continue;
  }
  console.log(name, typeof handler, "direct", show(commands[name](name === "hasOwnProperty" ? "echo" : "x")));
  console.log(name, "optional", show(commands[name]?.("shout")));
  try {
    console.log(name, "detached", show(handler("echo")));
  } catch (e) {
    console.log(name, "detached threw", (e as Error).name + ": " + (e as Error).message);
  }
}
console.log(typeof commands["toString"], typeof commands["valueOf"], commands["toString"] === undefined, commands["toString"] === commands["toString"]);
console.log(String(commands["toString"]("x")), commands["hasOwnProperty"]("shout"), commands["hasOwnProperty"]("nope"));
const literal: Record<string, Command> = {};
console.log(Object.keys(literal).length, literal["isPrototypeOf"]?.("x"), typeof literal.toString);

// A word count whose words are not Object.prototype names keeps `?? 0`.
const freq: Record<string, number> = {};
for (const w of "a rose is a rose is a rose".split(" ")) freq[w] = (freq[w] ?? 0) + 1;
console.log(JSON.stringify(freq), freq["tulip"] ?? 0);

// Read by name without a call: a plain function value.
const counts: Record<string, number> = { a: 1 };
const named = counts.toString;
console.log(typeof counts.toString, typeof commands.valueOf, String(named()));
