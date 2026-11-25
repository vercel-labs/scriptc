// A `declare` field has no storage of its own: its name is an own property
// of the instance once something assigns it, by name or by a key the
// compiler can read (corpus 9431). One name stays refused in the bracket
// spelling on an Error subclass: `stack` is a member the runtime error
// keeps itself, and the bracket write would add a second property under
// the same name.
class Overflow extends Error {
  declare stack: string;
  declare channel: number;
  limit = 10;
}
const overflow = new Overflow("past the limit");
overflow["stack"] = "trace";
const key = "stack" as const;
overflow[key] = "shorter trace";
overflow["channel"] = 3;
console.log(overflow.channel, overflow.limit);
