class Tagged {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  get kind(): number {
    return this.text.length;
  }
}

class Meter {
  readonly unit: string;
  constructor(unit: string) {
    this.unit = unit;
  }
  get size(): number {
    return this.unit.length;
  }
}

const tagged = new Tagged("abc");
const instance: unknown = tagged;
console.log((instance as { kind: number }).kind);
Object.defineProperty(instance, "kind", {
  value: 42,
  enumerable: true,
  writable: true,
  configurable: true,
});
console.log((instance as { kind: number }).kind);
console.log(Object.keys(instance as object).join(","));
console.log(Object.getOwnPropertyNames(instance as object).join(","));
console.log(Object.prototype.hasOwnProperty.call(instance as object, "kind"));
const descriptor = Object.getOwnPropertyDescriptor(instance as object, "kind");
console.log(descriptor?.value, descriptor?.writable, descriptor?.enumerable, descriptor?.configurable);
const spread = { ...(instance as Record<string, unknown>) };
console.log(Object.keys(spread).join(","), spread["kind"]);

const meter = new Meter("kilo");
const other: unknown = meter;
console.log((other as { size: number }).size);
Object.defineProperty(other, "size", {
  get(): number {
    return 7;
  },
  enumerable: true,
  configurable: true,
});
console.log((other as { size: number }).size);
console.log(Object.keys(other as object).join(","));
