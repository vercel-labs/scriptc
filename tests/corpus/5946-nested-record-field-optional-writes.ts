// A record held in another record's field, passed to a function that stores
// a possibly missing array element in it, keeps the write and its identity,
// as in Node; the outer record's layout holds the widened field.
type Parsed = { command: string; rest: string[] };
type Holder = { parsed: Parsed; label: string };

function fill(args: string[], into: Parsed): Parsed {
  into.command = args[0];
  into.rest = args.slice(1);
  return into;
}

const state = { parsed: { command: "", rest: [] as string[] } };
fill(["deep", "x"], state.parsed);
console.log(state.parsed.command, state.parsed.rest);
const alias = state.parsed;
fill([], state.parsed);
console.log(state.parsed.command, alias.command, alias === state.parsed, typeof alias.command);
console.log(state, JSON.stringify(state));

state.parsed = { command: "fresh", rest: [] };
fill(["again"], state.parsed);
console.log(state.parsed.command, alias.command);

function run(holder: Holder, args: string[]): string {
  fill(args, holder.parsed);
  return `${holder.label}:${holder.parsed.command ?? "none"}`;
}
console.log(run({ parsed: { command: "", rest: [] }, label: "a" }, ["go"]));
console.log(run({ parsed: { command: "", rest: [] }, label: "b" }, []));

function makeHolder(label: string): Holder {
  return { parsed: { command: "init", rest: [] }, label };
}
const made = makeHolder("made");
fill([], made.parsed);
console.log(made.parsed.command === undefined, made.label);
fill(["set"], made.parsed);
console.log(made.parsed.command.toUpperCase());

const empty: Parsed = { command: "x", rest: [] };
fill([], empty);
console.log(empty.command, empty.rest.length);
