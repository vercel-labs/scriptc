// LifetimeRegion (@scriptc/experimental) in a module whose program-lifetime
// class and a record hold a union that reaches itself through its own array
// arm, and one that is a nullable array of itself. The region emitter asks
// of every member type whether it can reach a program-lifetime instance;
// the question ends. Node.js runs the same program unchanged.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

type Outline = number | string | Outline[];
type Nest = Nest[] | null;

class Entry implements ProgramLifetime {
  readonly name: string;
  payload: Outline;
  hollow: Nest = null;
  constructor(name: string, payload: Outline) {
    this.name = name;
    this.payload = payload;
  }
}
interface Rack {
  first: Entry;
  spare: Outline;
}
function size(v: Outline): number {
  if (typeof v === "number" || typeof v === "string") return 1;
  let n = 0;
  for (const e of v) n += size(e);
  return n;
}
function depth(v: Nest): number {
  if (v === null) return 0;
  let most = 0;
  for (const inner of v) most = Math.max(most, depth(inner));
  return most + 1;
}

const region = new LifetimeRegion();
const total = region.run(() => {
  const rack: Rack = { first: new Entry("a", [1, ["two", [3]]]), spare: ["x", ["y"]] };
  rack.first.payload = [rack.first.payload, 4];
  rack.first.hollow = [null, [[null]]];
  return (
    size(rack.first.payload) * 100 +
    size(rack.spare) * 10 +
    depth(rack.first.hollow) +
    rack.first.name.length * 1000
  );
});
region.release();
console.log(total);
