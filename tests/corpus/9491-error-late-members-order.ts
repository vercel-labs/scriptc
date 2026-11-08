// An Error subclass instance lists its own properties in the order they were
// created: the class's fields, then whatever the program adds afterwards,
// `cause` and `code` among them, whichever spelling adds them. A read by
// name, `in`, `hasOwnProperty` and the descriptor agree with the listing.
import { inspect } from "node:util";

class SensorFault extends Error {
  bay = 4;
  probe = "soil";
}

function listed(fault: SensorFault): string {
  return [
    Object.keys(fault).join(","),
    JSON.stringify(fault),
    Object.entries(fault)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(","),
    Object.getOwnPropertyNames(fault).join(","),
  ].join(" | ");
}

function printed(fault: SensorFault): string {
  fault.stack = "";
  return inspect(fault);
}

// Assigned by name through the class.
const dry = new SensorFault("dry");
dry.cause = "valve";
console.log("by name:", listed(dry));
console.log(dry.cause, (dry as any).cause, "cause" in dry, Object.hasOwn(dry, "cause"));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(dry, "cause")));
console.log(printed(dry));

// Assigned through the Error type, in a function that knows no subclass.
function blame(fault: Error, reason: unknown): void {
  fault.cause = reason;
}
function stamp(fault: Error & { code?: string }, code: string): void {
  fault.code = code;
}
const wet = new SensorFault("wet");
stamp(wet, "E_WET");
blame(wet, "gasket");
console.log("through Error:", listed(wet));
console.log(wet.cause, (wet as Error & { code?: string }).code, (wet as any).code);

// Through an untyped reference, between two other added properties.
const hot = new SensorFault("hot");
(hot as any).first = 1;
(hot as any).code = "E_HOT";
(hot as any).cause = "vent";
(hot as any).last = 2;
console.log("untyped:", listed(hot));
console.log((hot as any).code, (hot as any).cause, hot.cause, "cause" in hot);
console.log(printed(hot));

// Object.assign copies in the source's order.
const cold = new SensorFault("cold");
Object.assign(cold, { code: "E_COLD", cause: "draught", shelf: 3 });
console.log("assigned:", listed(cold));
console.log((cold as any).code, cold.cause, (cold as any).shelf);

// A cause from the constructor's options is not enumerable and keeps its
// place before the fields; assigning to it changes the value only.
const dim = new SensorFault("dim", { cause: "lamp" });
console.log("options:", listed(dim));
dim.cause = "ballast";
(dim as any).code = "E_DIM";
console.log("options, assigned:", listed(dim));
console.log(dim.cause, (dim as any).cause, JSON.stringify(Object.getOwnPropertyDescriptor(dim, "cause")));
console.log(printed(dim));

// Written twice: the first write fixes the place.
const damp = new SensorFault("damp");
(damp as any).cause = "mist";
(damp as any).tray = 9;
damp.cause = "fog";
console.log("twice:", listed(damp));

// Caught as unknown.
try {
  throw dry;
} catch (caught) {
  console.log("caught:", Object.keys(caught as object).join(","), (caught as any).cause);
}
