// A `declare` field has no storage of its own: its name is an own property
// of the instance once something assigns it. The assignment by name
// compiles (`gauge.unit = "bar"`). The bracket spelling with a key the
// compiler can read is refused where it is written, on any class,
class Gauge {
  declare unit: string;
  level = 0;
}
const gauge = new Gauge();
gauge["unit"] = "bar";
const key = "unit" as const;
gauge[key] = "psi";
console.log(gauge.unit, gauge.level);
// and on an Error subclass for every declared name, `code` included.
class Overflow extends Error {
  declare code: string;
  declare channel: number;
  limit = 10;
}
const overflow = new Overflow("past the limit");
overflow["code"] = "E_OVERFLOW";
overflow["channel"] = 3;
console.log(overflow.code, overflow.channel, overflow.limit);
