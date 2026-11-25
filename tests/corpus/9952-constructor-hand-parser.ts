// A hand-written argument parser with the read shapes of the `arg` package:
// a specification of handlers, where a handler is a constructor or any
// function, a one-element array of a handler marks a repeatable option, and
// a string is an alias. The parser tests entries with typeof and
// Array.isArray, compares handlers with the constructors by identity, and
// calls them with the value, the option's name and the previous value.
type Handler = (value: string, name: string, previous?: unknown) => unknown;
type Spec = Record<string, string | Handler | [Handler]>;

function parse(spec: Spec, argv: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const rest: string[] = [];
  const handlers = new Map<string, { type: Handler; flag: boolean; list: boolean }>();
  const aliases = new Map<string, string>();
  for (const key of Object.keys(spec)) {
    const entry = spec[key]!;
    if (typeof entry === "string") {
      aliases.set(key, entry);
    } else if (Array.isArray(entry) && entry.length === 1 && typeof entry[0] === "function") {
      handlers.set(key, { type: entry[0], flag: entry[0] === Boolean, list: true });
    } else if (typeof entry === "function") {
      handlers.set(key, { type: entry, flag: entry === Boolean, list: false });
    } else {
      throw new Error(`type missing or not a function or valid array type: ${key}`);
    }
  }
  for (let i = 0; i < argv.length; i++) {
    const whole = argv[i]!;
    if (whole.length < 2 || whole[0] !== "-") {
      rest.push(whole);
      continue;
    }
    const cut = whole.startsWith("--") ? whole.indexOf("=") : -1;
    const written = cut < 0 ? whole : whole.slice(0, cut);
    let name = written;
    while (aliases.has(name)) name = aliases.get(name)!;
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`unknown or unexpected option: ${written}`);
    let value: unknown;
    if (handler.flag) {
      value = true;
    } else if (cut >= 0) {
      value = handler.type(whole.slice(cut + 1), name, result[name]);
    } else {
      const next = argv[i + 1];
      const negative = handler.type === Number && next !== undefined && /^-\d/.test(next);
      if (next === undefined || (next.startsWith("-") && !negative))
        throw new Error(`option requires argument: ${written} (${handler.type.name})`);
      value = handler.type(next, name, result[name]);
      i++;
    }
    if (handler.list) {
      const previous = result[name];
      const list: unknown[] = Array.isArray(previous) ? previous : [];
      list.push(value);
      result[name] = list;
    } else {
      result[name] = value;
    }
  }
  result["_"] = rest;
  return result;
}

const count: Handler = (_value, _name, previous) => (typeof previous === "number" ? previous : 0) + 1;
const spec: Spec = {
  "--help": Boolean,
  "--name": String,
  "--port": Number,
  "--tag": [String],
  "--level": [Number],
  "--verbose": count,
  "-h": "--help",
  "-n": "--name",
  "-p": "--port",
  "-t": "--tag",
  "-v": "--verbose",
};

const argv = ["resize", "-h", "--name=site", "-p", "8080", "--tag", "a", "-t", "b", "--tag=c=d"];
console.log(JSON.stringify(parse(spec, [...argv, "--level", "-2", "--level=3", "-v", "x", "-v", "y", "rest"])));
console.log(JSON.stringify(parse(spec, ["-n", "", "--port=", "--port", "0x1f"])));
for (const bad of [["--nope"], ["--name"], ["-p", "--help"], ["--tag"]]) {
  try {
    parse(spec, bad);
  } catch (err) {
    console.log(err instanceof Error ? err.message : "not an error");
  }
}
console.log(spec["--help"] === Boolean, spec["--port"] === Number, spec["--verbose"] === count);
