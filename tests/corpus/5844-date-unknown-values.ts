// Date values converted into `unknown` slots stay Dates: typeof answers
// "object", instanceof Date holds, util.inspect prints the ISO form or
// "Invalid Date", JSON.stringify calls toJSON (null for an invalid date),
// a method read through an untyped reference is a function that takes a
// Date receiver, and the value converts back to a typed Date with the same
// time value.
import { inspect } from "node:util";

const epoch = new Date(0);
const bare: unknown = epoch;
const record: unknown = { when: new Date(86_400_000), n: 1 };
const list: unknown = [new Date(Date.UTC(2024, 1, 29, 12, 30)), new Date(Number.NaN)];
const bag: Record<string, unknown> = { at: epoch };

console.log(typeof bare, bare instanceof Date, inspect(bare), JSON.stringify(bare));
console.log(record, JSON.stringify(record), Object.keys(record as object));
console.log(list, JSON.stringify(list));
console.log(bag, JSON.stringify(bag));

const when = (record as { when: unknown }).when;
console.log(typeof when, when instanceof Date);
if (when instanceof Date) console.log(when.getTime(), when.toISOString(), when.getUTCDate());
const back = bare as Date;
console.log(back.getTime(), back.toISOString());
const dynamic = record as any;
console.log(dynamic.when.getTime(), dynamic.when.getUTCFullYear(), String(dynamic.when instanceof Date));
const read = dynamic.when.getUTCHours;
console.log(typeof read, read.name, read.call(dynamic.when), dynamic.when.missing);
try {
  read.call({});
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

type Event = { at: Date; tags: string[] };
const events: Event[] = [
  { at: new Date(0), tags: ["a"] },
  { at: new Date(7), tags: [] },
];
const eventsUnknown: unknown = events;
console.log(eventsUnknown, JSON.stringify(eventsUnknown));
console.log((eventsUnknown as Event[])[1]!.at.toISOString());
class Holder {
  value: unknown = null;
}
const holder = new Holder();
holder.value = new Date(1000);
console.log(holder, JSON.stringify(holder.value));
const invalid: any = { d: new Date(Number.NaN) } as unknown;
try {
  console.log(invalid.d.toISOString());
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
console.log(invalid.d.getTime(), JSON.stringify(invalid));
const stamped: Readonly<Date> = new Date(0);
console.log(stamped.getTime(), stamped.toISOString());
