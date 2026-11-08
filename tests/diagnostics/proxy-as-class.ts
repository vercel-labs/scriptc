// A Proxy where the program's types say "an instance of this class". A
// class slot holds native instances only, so each of these would throw a
// TypeError when it ran; the build refuses them instead.
class Gauge {
  readonly unit: string;
  private level = 0;
  constructor(unit: string) {
    this.unit = unit;
  }
  read(): string {
    return `${this.level}${this.unit}`;
  }
}
let reads = 0;
// A typed binding over an asserted empty object, with a trap that counts.
const counted: Gauge = new Proxy({} as Gauge, {
  get(target, key, receiver) {
    reads++;
    return Reflect.get(target, key, receiver);
  },
});
// Over a real instance, the binding left to inference.
const brass = new Gauge("mm");
const traced = new Proxy(brass, {
  has(target: any, key: string | symbol): boolean {
    return key in target;
  },
});
const traps: any = {
  get(_target: any, key: string | symbol): any {
    return (brass as any)[key];
  },
};
// A `let` binding, a field, an argument, a return, an element, an optional slot, an assertion.
let swapped: Gauge = new Proxy({} as any, traps);
class Station {
  gauge: Gauge;
  spare: Gauge | undefined;
  constructor() {
    this.gauge = new Proxy({} as any, traps);
  }
}
function reading(gauge: Gauge): string {
  return gauge.read();
}
function fresh(): Gauge {
  return new Proxy({} as any, traps);
}
const station = new Station();
station.spare = new Proxy({} as any, traps);
const row: Gauge[] = [new Proxy({} as any, traps)];
const claimed = new Proxy({} as any, traps) as Gauge;
// A Proxy held untyped is a Proxy; the build sees it enter the class slot.
const loose: any = new Proxy({} as any, traps);
console.log(reading(new Proxy({} as any, traps)));
console.log(reading(loose));
console.log(fresh().unit, row.length, reads);
console.log(counted.unit, traced.unit, swapped.unit, station.gauge.unit, claimed.unit);
