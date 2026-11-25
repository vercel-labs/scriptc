// Object.getPrototypeOf of a value whose static type is a base class answers
// the prototype of the object's own class: a subclass instance passed or
// stored as its base class still has the subclass's prototype.
function note(target: any, key: string, value: unknown): void {
  target[key] = value;
}
note({}, "seen", 1);

class Instrument {
  family(): string {
    return "instrument";
  }
  strings(): number {
    return 0;
  }
}
class Lute extends Instrument {
  strings(): number {
    return 13;
  }
  courses(): number {
    return 7;
  }
}
class Theorbo extends Lute {
  bassStrings(): number {
    return 8;
  }
}

function membersOf(instrument: Instrument): string {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(instrument)).join(",");
}
function classOf(instrument: Instrument): string {
  return String(Object.getPrototypeOf(instrument).constructor.name);
}
function lineage(value: unknown): string {
  const names: string[] = [];
  let proto = Object.getPrototypeOf(value);
  while (proto !== null && proto !== Object.prototype) {
    names.push(String(proto.constructor.name));
    proto = Object.getPrototypeOf(proto);
  }
  return names.join(" > ");
}

const made: Instrument[] = [new Instrument(), new Lute(), new Theorbo()];
for (const instrument of made) {
  console.log(membersOf(instrument));
  console.log(classOf(instrument), lineage(instrument));
  console.log(instrument.family(), instrument.strings());
}

// The same through a binding of the base type and through the exact type.
const lute = new Lute();
const held: Instrument = lute;
console.log(membersOf(held), "|", Object.getOwnPropertyNames(Object.getPrototypeOf(lute)).join(","));
console.log(Object.getPrototypeOf(held) === Object.getPrototypeOf(lute));

// A base instance keeps the base prototype after subclasses were seen.
const plain: Instrument = new Instrument();
console.log(membersOf(plain), classOf(plain));
