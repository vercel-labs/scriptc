// @requires-libnode
// A native subclass of an island class: the island constructs the instance,
// so the fields the subclass declares are properties of the island's object.
// A field typed by one of the program's record types is read out of the
// island like any island value: `this.field` is the one object the program
// stored there (never a copy), a write through it is seen at the next read,
// and the island lists the property among the object's own.
import { Fixture } from "fixture-pkg";

type Dimmer = { turn: (steps: number) => void; settle: () => void };
function makeDimmer(name: string, log: string[]): Dimmer {
  let level = 0;
  return {
    turn: (steps: number): void => {
      level += steps;
    },
    settle: (): void => {
      log.push(`${name}=${level}`);
      level = 0;
    },
  };
}

class Lamp extends Fixture {
  private dimmer?: Dimmer;
  private reading?: { lumens: number | null; tint: string | null };
  private lit = true;
  private clicks = 0;
  wire(name: string | undefined, log: string[]): void {
    this.dimmer = name ? makeDimmer(name, log) : undefined;
    if (this.dimmer) {
      const dimmer = this.dimmer;
      dimmer.turn(2);
      dimmer.turn(3);
      dimmer.settle();
    }
  }
  wired(): boolean {
    return this.dimmer !== undefined;
  }
  measure(lumens: number | null, tint: string | null): void {
    this.reading = { lumens, tint };
    this.lit = false;
    this.clicks += 1;
  }
  summary(): string {
    if (this.reading || !this.lit) {
      const { lumens = null, tint = null } = this.reading ?? {};
      return `measured ${tint || lumens}`;
    }
    return "unmeasured";
  }
  same(): boolean {
    const first = this.reading;
    const second = this.reading;
    return first === second && first !== undefined;
  }
  correct(lumens: number): string {
    const reading = this.reading;
    if (reading) reading.lumens = lumens;
    return `${this.reading?.lumens} after ${this.clicks}`;
  }
}

const log: string[] = [];
const desk = new Lamp("study");
desk.wire("desk", log);
const hall = new Lamp("hall");
hall.wire(undefined, log);
console.log(log.join(";"), desk.wired(), hall.wired());

const porch = new Lamp("porch");
console.log(porch.summary(), porch.describe());
porch.measure(300, null);
console.log(porch.summary(), porch.describe(), porch.same(), porch.correct(280));
const attic = new Lamp("attic");
attic.measure(null, "amber");
console.log(attic.summary());
