// A class rooted in a runtime-provided class converts to a record of the
// fields its program classes declare. An optional member of the record that
// no program class declares is not read as absent: the runtime class may hold
// it (an error's stack, a stream's state), so the conversion stays refused.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

class Spill extends Error {
  litres = 3;
}
class Pump extends Readable {
  bore = 40;
  _read(): void {}
}
class Valve extends EventEmitter {
  bore = 15;
}

function traced(source: { litres: number; stack?: string }): string {
  return `${source.litres} ${typeof source.stack}`;
}
function flowing(source: { bore: number; readable?: boolean; destroyed?: boolean }): string {
  return `${source.bore} ${String(source.readable)} ${String(source.destroyed)}`;
}
function labelled(source: { bore: number; label?: string }): string {
  return `${source.bore} ${source.label ?? "plain"}`;
}

console.log(traced(new Spill("spill")));
console.log(flowing(new Pump()));
console.log(labelled(new Valve()));
