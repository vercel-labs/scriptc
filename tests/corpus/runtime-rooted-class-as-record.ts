// An instance of a class rooted in a runtime-provided class (EventEmitter,
// Error) passed where a record type names fields the program's own classes
// declare: the conversion reads those fields as it does for a class with no
// runtime base. Helpers that only read get the fields; a helper that writes
// through the record, compares it or lists it sees the instance itself.
import { EventEmitter } from "node:events";

class Gauge {
  celsius: number;
  constructor(celsius: number) {
    this.celsius = celsius;
  }
  describe(): string {
    return `${this.celsius}C`;
  }
  warm(by: number): void {
    this.celsius += by;
  }
}

class Kiln extends EventEmitter {
  gauge: Gauge;
  shelves = 4;
  glaze = "celadon";
  constructor(gauge: Gauge) {
    super();
    this.gauge = gauge;
  }
}

class LoadedKiln extends Kiln {
  pieces = 12;
  lid?: string;
}

class Misfire extends Error {
  gauge: Gauge;
  shelves = 2;
  constructor(gauge: Gauge) {
    super("misfire");
    this.gauge = gauge;
  }
}

// Read-only helpers: a function declaration, an arrow function, a method.
function reading(source: { gauge: Gauge }): string {
  return source.gauge.describe();
}
const capacity = (source: { shelves: number; gauge: Gauge }): number =>
  source.shelves * 3 + source.gauge.celsius;
class Ledger {
  line(source: { pieces: number; glaze: string; lid?: string }): string {
    return `${source.pieces} ${source.glaze} ${source.lid ?? "open"}`;
  }
}

const kiln = new Kiln(new Gauge(900));
const loaded = new LoadedKiln(new Gauge(1200));
const misfire = new Misfire(new Gauge(40));

console.log(reading(kiln), reading(loaded), reading(misfire));
console.log(capacity(kiln), capacity(loaded), capacity(misfire));
console.log(new Ledger().line(loaded));

// The named member is the instance's own object: a change made through the
// record's member is the instance's.
function heat(source: { gauge: Gauge }, by: number): void {
  source.gauge.warm(by);
}
heat(kiln, 50);
heat(misfire, 5);
console.log(kiln.gauge.celsius, misfire.gauge.celsius);

// Other slots of the record type: a field, an element, a returned value.
const rack: { item: { gauge: Gauge } } = { item: kiln };
const queue: { gauge: Gauge }[] = [loaded, misfire];
function hottest(): { gauge: Gauge } {
  return loaded;
}
console.log(rack.item.gauge.describe(), queue.map((entry) => entry.gauge.celsius).join(","));
console.log(hottest().gauge.describe());

// The instances are still what they were.
kiln.on("fired", (cone: number) => console.log("fired at cone", cone, kiln.shelves));
kiln.emit("fired", 6);
console.log(misfire instanceof Error, misfire.message, loaded instanceof Kiln, loaded.listenerCount("fired"));

// A record type the program writes through is the instance, not a copy of it.
type Shelved = { shelves: number };
function addShelf(target: Shelved): void {
  target.shelves += 1;
}
addShelf(kiln);
addShelf(misfire);
const sameKiln: Shelved = kiln;
console.log(kiln.shelves, misfire.shelves, sameKiln === kiln, sameKiln.shelves);
kiln.shelves = 9;
console.log(sameKiln.shelves);
