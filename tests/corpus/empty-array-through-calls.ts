// An empty array literal with no element type of its own, passed on: for a
// type parameter, through a conditional, through an object spread, and by a
// spread copy. Where the literal is written says nothing about its
// elements, so the array is typed by where its value goes: the constraint
// of the type parameter it is passed for, the declared slot another use
// names, the array type the other arm of a conditional has. It stays one
// array under every name; only a spread copy is a new one.

interface Stop {
  town: string;
  minutes: number;
  request: boolean;
}

interface Route {
  line: string;
  stops: readonly Stop[];
}

// The type parameter is the array itself: the checker binds it to the
// argument's own type, which for an empty table names no element.
function timetable<T extends ReadonlyArray<Stop>>(stops: T): string {
  const parts: string[] = [];
  let total = 0;
  for (const stop of stops) {
    total += stop.minutes;
    parts.push(stop.request ? `(${stop.town})` : stop.town);
  }
  return `${stops.length} stops, ${total} min: ${parts.join(" > ")}`;
}

// No type parameter: the declared slot names the element.
function longest(stops: readonly Stop[]): string {
  let best = "";
  let most = -1;
  for (const stop of stops) {
    if (stop.minutes > most) {
      most = stop.minutes;
      best = stop.town;
    }
  }
  return best === "" ? "none" : best;
}

// The type parameter is the element, inferred from the other argument.
function after<S extends Stop>(first: S, rest: readonly S[]): string {
  return [first.town, ...rest.map((stop) => stop.town)].join(",");
}

function describe(route: Route): string {
  return `${route.line}: ${route.stops.length}`;
}

const coast = {
  line: "coast",
  stops: [
    { town: "Arle", minutes: 12, request: false },
    { town: "Brow", minutes: 7, request: true },
    { town: "Cove", minutes: 21, request: false },
  ],
} as const;
const depot = { line: "depot", stops: [] } as const;
const spare = { line: "spare", stops: [] };
const NOWHERE = [] as const;

// A type parameter bound by an empty table, before and after a filled one.
console.log(timetable(depot.stops));
console.log(timetable(coast.stops));
console.log(timetable(spare.stops));
console.log(timetable(NOWHERE));
console.log(timetable(depot.stops));

// The same table also goes into a declared slot: stored at the declared
// type, read back, and passed for the type parameter again.
console.log(describe(depot), describe(coast));
const shown: Route = depot;
console.log(shown.stops.length, timetable(depot.stops));
const garage = { line: "garage", stops: [], open: true } as const;
const yard: Route = garage;
console.log(timetable(garage.stops), yard.stops.length, garage.open);

// One array under both names: the record's field and the type parameter's
// argument are the same object.
interface Depot {
  name: string;
  bays: readonly string[];
}
function bays<T extends readonly string[]>(names: T): T {
  return names;
}
const shed = { name: "shed", bays: [] } as const;
const held: Depot = shed;
console.log(held.bays === shed.bays, bays(shed.bays) === held.bays, bays(shed.bays).length);

// Through a conditional: the binding holds the table either arm reads.
const quiet = process.argv.length > 99 ? coast.stops : depot.stops;
console.log(longest(quiet), after(coast.stops[1], quiet));
const busy = process.argv.length < 99 ? coast.stops : depot.stops;
console.log(longest(busy), timetable(depot.stops));

// Through an object spread: the property is the one the spread object wrote.
const template = { stops: [] } as const;
const night = { ...template, line: "night" };
console.log(longest(night.stops), describe(night));
const plain = { bays: [] } as const;
const annex = { ...plain, name: "annex" };
const kept: Depot = annex;
console.log(annex.bays === plain.bays, kept.bays === plain.bays, kept.name);

// A spread copy is a new array of whatever the table holds: nothing.
console.log(longest([...depot.stops]), timetable([...depot.stops]));
console.log(after(coast.stops[0], [...depot.stops]));
const extended: Stop[] = [...depot.stops, { town: "Dene", minutes: 4, request: false }];
console.log(longest(extended), extended.length, depot.stops.length);

// A mutable empty array passed for a type parameter: the write through the
// parameter is a write to the object's own array.
function board<T extends string[]>(names: T, name: string): number {
  names.push(name);
  return names.length;
}
const coach = { seats: 2, riders: [] };
console.log(board(coach.riders, "Ines"), board(coach.riders, "Odo"));
console.log(coach.riders.length, coach.riders.join("+"), JSON.stringify(coach));

// One empty constant passed for two type parameters whose constraints name
// different elements: neither decides it, and each call takes it as it is.
function towns<T extends readonly string[]>(names: T): number {
  return names.length;
}
function times<T extends readonly number[]>(minutes: T): number {
  return minutes.length;
}
const NOTHING = [] as const;
console.log(towns(NOTHING), times(NOTHING), NOTHING.length);

// The same forms in code that never runs still compile.
function never(): void {
  const closed = { line: "closed", stops: [] } as const;
  const either = process.argv.length > 99 ? coast.stops : closed.stops;
  console.log(timetable(closed.stops), longest(either), longest([...closed.stops]));
}
if (process.argv.length > 99) never();
console.log("done");
