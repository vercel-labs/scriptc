// A package function whose declared result is computed from the type of its
// argument. Given a table whose type names its keys, every member of the
// result has the type its reader answers. Given a table built at run time,
// whose type is the package's general table type, every member is declared
// `undefined`: the declaration boundary checks that, and here it holds,
// because the line names none of the table's keys.
import { many, readLine, type Fields } from "kv-line";

const text = (value: string): string => value;
const amount = (value: string): number => Number(value);

// The table's own type: station readings from a weather log.
const reading = readLine(
  { station: text, celsius: amount, gusts: many(amount) },
  "station=north;celsius=4.5;gusts=7;gusts=12;note=dry",
);
const station = reading.station;
console.log(station === "north", reading.celsius, reading.gusts?.join("+"), reading.skipped.join(","));

// A table built at run time: its members are declared `undefined`, and are.
function tableOf(keys: string[]): Fields {
  const fields: Fields = {};
  for (const key of keys) fields[key] = text;
  return fields;
}
const loose = readLine(tableOf(["observer", "site"]), "celsius=4.5;gusts=7");
const observer = loose["observer"];
console.log(observer === undefined, observer ?? "nobody", loose["site"] ? "sited" : "unsited");
function lengthOf(value: string | undefined): number {
  return value === undefined ? -1 : value.length;
}
console.log(lengthOf(loose["site"]), typeof loose["observer"], `${loose["site"]}`);
const sites = (loose["site"] as string[] | undefined) ?? [];
console.log(sites.length, loose.skipped.join(","));
