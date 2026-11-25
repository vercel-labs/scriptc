// Pins: the order in which an array pattern reads a tuple that may be the
// empty array literal, `const [a = f(), b] = pair ?? []`. The source is
// evaluated once. Then, for each binding in turn, its position is read, its
// default runs if the position holds undefined, and the name is bound. A
// default that writes a later position of the tuple being destructured is
// therefore seen by the later binding, as in Node.
type Seat = [guest: string | undefined, table: number];

// A default that assigns a later position.
const seat: Seat = [undefined, 1];
const booked: Seat | undefined = process.argv.length > 99 ? undefined : seat;
const [guest = ((seat[1] = 5), "walk-in"), table] = booked ?? [];
console.log(guest, table, seat[1]);

// A default that calls a function which writes the later position, behind a
// conditional with the literal in either arm, and behind `||`.
const bench: Seat = [undefined, 2];
function moveBench(): string {
  bench[1] = bench[1] + 10;
  return "moved";
}
const open = process.argv.length < 99;
const [who = moveBench(), where] = open ? bench : [];
console.log(who, where, bench[1]);
const [whoElse = moveBench(), whereElse] = !open ? [] : bench;
console.log(whoElse, whereElse, bench[1]);
const [third = moveBench(), thirdPlace] = (open ? bench : undefined) || [];
console.log(third, thirdPlace, bench[1]);

// The literal picked: the defaults run in order, and nothing is read.
const order: string[] = [];
function note(name: string, value: number): number {
  order.push(name);
  return value;
}
const none: [number | undefined, number | undefined] | undefined = process.argv.length > 99 ? [1, 2] : undefined;
const [low = note("low", 10), high = note("high", 20)] = none ?? [];
console.log(low, high, order.join(">"));

// Three positions: the first default clears the second, whose default then
// runs and writes the third.
const chain: [number | undefined, number | undefined, number] = [undefined, 2, 3];
function held(): [number | undefined, number | undefined, number] | undefined {
  return process.argv.length > 99 ? undefined : chain;
}
const [one = ((chain[1] = undefined), 1), two = ((chain[2] = 30), 20), three] = held() ?? [];
console.log(one, two, three, JSON.stringify(chain));

// A default that writes its own position or an earlier one changes the tuple
// and not the names already bound.
const pew: Seat = [undefined, 4];
const pewNow: Seat | undefined = process.argv.length > 99 ? undefined : pew;
const [sitter = ((pew[0] = "late"), "early"), pewTable] = pewNow ?? [];
console.log(sitter, pewTable, pew[0]);
const stool: [number, string | undefined] = [7, undefined];
const stoolNow: [number, string | undefined] | undefined = process.argv.length > 99 ? undefined : stool;
const [legs, colour = ((stool[0] = 70), "red")] = stoolNow ?? [];
console.log(legs, colour, stool[0]);

// A default that replaces the variable the source was read from: the pattern
// goes on reading the tuple it started with.
let current: Seat | undefined = [undefined, 6];
const [kept = ((current = undefined), "kept"), keptTable] = current ?? [];
console.log(kept, keptTable, current === undefined);

// A default that throws: the bindings after it are not reached, so their
// positions are not read and their defaults do not run.
const stall: [string | undefined, number | undefined] = [undefined, undefined];
function refuse(): string {
  throw new RangeError("no seat");
}
function seatAt(source: [string | undefined, number | undefined] | undefined): string {
  const [name = refuse(), number = note("number", 0)] = source ?? [];
  return `${name} ${number}`;
}
try {
  console.log(seatAt(stall));
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message, order.join(">"));
}

// `let` bindings, and a default that reads the binding before it.
function lateGuest(source: Seat): string {
  const given: Seat | undefined = process.argv.length > 99 ? undefined : source;
  let [name = ((source[1] = 8), "nobody"), number] = given ?? [];
  name = name + "!";
  number = (number ?? 0) + 1;
  return `${name} ${number}`;
}
function sized(source: [string | undefined, number | undefined] | undefined): string {
  const [name = "anon", size = name.length] = source ?? [];
  return `${name} ${size}`;
}
console.log(lateGuest([undefined, 3]), sized(undefined), sized(["ada", undefined]), sized([undefined, 9]));
