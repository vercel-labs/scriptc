// A field declared with `declare` takes no storage: JavaScript emits nothing
// for it, so its name is an own property of the instance from the moment
// something assigns it, listed after the fields the class defines. On an
// Error subclass that holds for `code` too: the write by name, the write
// through an untyped or an Error-typed view, and every read reach the same
// property.
class SensorFault extends Error {
  declare code: string;
  declare channel: number;
  unit = "C";
  constructor(message: string, code?: string) {
    super(message);
    if (code !== undefined) this.code = code;
  }
  label(): string {
    return `${this.code}@${this.channel}`;
  }
}

function show(tag: string, fault: SensorFault): void {
  console.log(
    tag,
    fault.code,
    typeof fault.code,
    "code" in fault,
    Object.keys(fault).join(","),
    JSON.stringify(fault),
  );
}

// Assigned in the constructor, then read every way.
const frozen = new SensorFault("probe frozen", "E_FROZEN");
show("constructor", frozen);
console.log((frozen as any).code, frozen["code"], frozen.label());
const loose: Error & { code?: string } = frozen;
console.log(loose.code, loose.message);

// Never assigned: absent, and undefined to every read.
const quiet = new SensorFault("no reading");
show("absent", quiet);
console.log((quiet as any).code, quiet.code ?? "none", quiet.channel ?? -1);

// Assigned later by name, by a literal key, and through an untyped view.
quiet.code = "E_SILENT";
quiet.channel = 4;
show("by name", quiet);
quiet["code"] = "E_KEYED";
show("by key", quiet);
(quiet as any).code = "E_UNTYPED";
show("untyped", quiet);
console.log(quiet.label(), quiet.code === "E_UNTYPED");

// A catch clause reads the same property after the class test.
try {
  throw new SensorFault("lost contact", "E_LOST");
} catch (caught) {
  if (caught instanceof SensorFault) console.log("caught", caught.code, caught.unit);
  console.log("untyped catch", (caught as any).code);
}

// A subclass without fields of its own inherits the declaration.
class RangeFault extends SensorFault {}
const high = new RangeFault("above range", "E_HIGH");
high.channel = 2;
show("subclass", high);

// A subclass that defines the field stores it as its own field.
class Calibrated extends SensorFault {
  code = "E_CAL";
}
const calibrated = new Calibrated("drift");
show("defined", calibrated);
(calibrated as any).code = "E_SET";
show("defined, untyped write", calibrated);

// A write through the Error type reaches whatever the value is: an instance
// that declares `code`, one that defines it, or a plain Error.
function stamp(error: Error & { code?: string }, code: string): void {
  error.code = code;
}
const stamped = new SensorFault("stamped");
stamp(stamped, "E_STAMPED");
show("via Error", stamped);
stamp(calibrated, "E_RECAL");
show("via Error, defined", calibrated);
const plain: Error & { code?: string } = new Error("plain");
stamp(plain, "E_PLAIN");
console.log("plain", plain.code, "code" in plain);

// A numeric code is the same property with another type.
class NumberedFault extends Error {
  declare code: number;
  retries = 0;
}
const numbered = new NumberedFault("timeout");
numbered.code = 408;
console.log(numbered.code + 1, Object.keys(numbered).join(","), JSON.stringify(numbered));

// On a class that is not an error the same holds for every declared name,
// by name and by a key the compiler can read.
class Gauge {
  declare unit: string;
  level = 0;
}
const gauge = new Gauge();
console.log(gauge.unit, "unit" in gauge, Object.keys(gauge).join(","));
gauge["unit"] = "bar";
const key = "unit" as const;
console.log(gauge.unit, gauge[key], "unit" in gauge, Object.keys(gauge).join(","));
gauge[key] = "psi";
gauge.level = 3;
console.log(gauge.unit, JSON.stringify(gauge));
