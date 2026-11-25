// A value whose type is a union of class instances and plain values (a
// record, a string, a number, null) keeps that union when a class test
// narrows it. Where the narrowed value is then used as the tested class,
// every arm the test left converts to the class and stays the same object.

// Error classes beside a record: `instanceof Error`.
class Oversize extends Error {
  limit = 30;
}
class Unreadable extends Error {
  tries = 2;
}
type Routed = { bay: number };
function route(weight: number): Oversize | Unreadable | Routed {
  if (weight > 30) return new Oversize("too heavy");
  if (weight < 0) return new Unreadable("label smudged");
  return { bay: weight % 4 };
}
function describe(problem: Error): string {
  return `${problem.name}: ${problem.message}`;
}
const problems: Error[] = [];
for (const weight of [12, 45, -1]) {
  const outcome = route(weight);
  if (outcome instanceof Error) {
    const kept: Error = outcome;
    problems.push(outcome);
    console.log("problem", describe(outcome), kept === problems[problems.length - 1], kept.message);
  } else {
    console.log("bay", outcome.bay);
  }
}
console.log(problems.length, problems.map((p) => p.message).join("; "));

// A program base class, a negated test with an early exit, and number and
// null among the plain arms.
class SortFault extends Error {
  lane = "main";
}
class Jammed extends SortFault {
  belt = 7;
}
class Misfed extends SortFault {
  side = "left";
}
function feed(step: number): Jammed | Misfed | number | null {
  if (step === 1) return new Jammed("belt stopped");
  if (step === 2) return new Misfed("wrong side");
  if (step === 3) return null;
  return step * 10;
}
function lane(fault: SortFault): string {
  return `${fault.lane}/${fault.message}`;
}
function firstFault(fault: SortFault): SortFault {
  return fault;
}
function check(step: number): string {
  const fed = feed(step);
  if (!(fed instanceof SortFault)) return fed === null ? "idle" : `speed ${fed + 1}`;
  const same = firstFault(fed);
  const again: SortFault = fed;
  if (fed instanceof Jammed) return `jammed belt ${fed.belt} ${lane(fed)} ${same === again}`;
  return `fault ${lane(fed)} ${same === again}`;
}
for (const step of [0, 1, 2, 3]) console.log(check(step));

// The narrowed value thrown and caught again is the object that was made.
function rethrow(step: number): string {
  const fed = feed(step);
  if (fed instanceof Error) {
    const thrown: Error = fed;
    try {
      throw fed;
    } catch (caught) {
      return caught === thrown && caught instanceof Misfed ? `misfed ${caught.side}` : "other fault";
    }
  }
  return "nothing thrown";
}
console.log(rethrow(1), rethrow(2), rethrow(0));

// Classes that are not errors beside a string, tested in a conditional
// expression and through a type guard.
class Crate {
  slots = 6;
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
}
class Barrel extends Crate {
  litres = 200;
}
class Sack extends Crate {
  kilos = 25;
}
function unload(n: number): Barrel | Sack | string {
  if (n === 0) return new Barrel("B-1");
  if (n === 1) return new Sack("S-9");
  return "empty dock";
}
function tagOf(crate: Crate): string {
  return `${crate.tag}:${crate.slots}`;
}
function isCrate(value: unknown): value is Crate {
  return value instanceof Crate;
}
for (const n of [0, 1, 2]) {
  const cargo = unload(n);
  console.log(cargo instanceof Crate ? tagOf(cargo) : cargo.toUpperCase());
  if (isCrate(cargo)) {
    const held: Crate = cargo;
    console.log("guarded", tagOf(held), held instanceof Barrel ? held.litres : -1);
  }
}

// A class test on a union that holds no class at all is false for every
// value: the branch compiles and never runs.
type Slip = { berth: number; vessel: string };
function assign(n: number): Slip | null {
  return n === 0 ? null : { berth: n, vessel: "tug" };
}
function report(problem: Error): string {
  return `unexpected ${problem.message}`;
}
for (const n of [0, 2]) {
  const slip = assign(n);
  if (slip instanceof Error) console.log(report(slip));
  else if (slip === null) console.log("no slip");
  else console.log("slip", slip.berth, slip.vessel);
}
