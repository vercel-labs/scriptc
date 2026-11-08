// A class's prototype read through a dynamic value answers with the class's
// own methods for every class that has an instance: one made with `new`, one
// made through its constructor held as `unknown`, and one that is only the
// base of a constructed class. A class of the same family that nothing
// constructs takes no part. A function-typed static called through the
// class name passes the class as the call's receiver, which a function that
// reads its receiver sees with the class's static members.

class Sensor {
  static unit: string = "raw";
  static scale = function (this: unknown, reading: number): string {
    const self = this;
    if (typeof self !== "function") return "no receiver";
    const statics = self as unknown as { [key: string]: unknown };
    return reading + " " + String(statics["unit"]) + " " + String(statics["absent"]);
  };
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  read(): number {
    return 1;
  }
  describe(): string {
    return this.label + "=" + this.read();
  }
}

class Thermometer extends Sensor {
  static unit: string = "kelvin";
  read(): number {
    return 273;
  }
}

// Only the base of Hygrometer: no instance of its own.
class Calibrated extends Sensor {
  offset: number = 2;
  read(): number {
    return 10 + this.offset;
  }
}

class Hygrometer extends Calibrated {
  describe(): string {
    return "humidity " + super.describe();
  }
}

// Constructed only through its constructor held as `unknown`.
class Barometer extends Sensor {
  read(): number {
    return 1013;
  }
}

// Never constructed, never held as a value.
class Phantom extends Sensor {
  read(): number {
    return -1;
  }
  haunt(): string {
    return "boo";
  }
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function prototypeOf(value: unknown): { [key: string]: unknown } | null {
  const prototype: unknown = Object.getPrototypeOf(value);
  return isRecord(prototype) ? prototype : null;
}

function inspectInstance(name: string, value: unknown): void {
  const prototype = prototypeOf(value);
  if (prototype === null) {
    console.log(name, "no prototype");
    return;
  }
  const read = prototype["read"];
  const describe = prototype["describe"];
  console.log(
    name,
    "own read",
    Object.hasOwn(prototype, "read"),
    "own describe",
    Object.hasOwn(prototype, "describe"),
    "keys",
    Object.getOwnPropertyNames(prototype).join(","),
  );
  if (typeof read === "function") console.log("  read", read.call(value));
  if (typeof describe === "function") console.log("  describe", describe.call(value));
  const above = prototypeOf(prototype);
  console.log("  above", above === null ? "none" : Object.getOwnPropertyNames(above).join(","));
  if (isRecord(value)) console.log("  haunt", typeof value["haunt"], "label", value["label"]);
}

function construct(constructor: unknown, label: string): unknown {
  if (typeof constructor !== "function") return null;
  const make = constructor as unknown as new (label: string) => unknown;
  return new make(label);
}

const held: unknown = Barometer;
const instances: Array<[string, unknown]> = [
  ["sensor", new Sensor("s")],
  ["thermometer", new Thermometer("t")],
  ["hygrometer", new Hygrometer("h")],
  ["barometer", construct(held, "b")],
];
for (const [name, instance] of instances) inspectInstance(name, instance);

console.log(Sensor.scale(4));
console.log(Thermometer.scale(5));
const typed = new Hygrometer("typed");
console.log(typed.describe(), typed.read(), typed instanceof Calibrated, typed instanceof Sensor);
