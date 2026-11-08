// A class method read as a value has the name it is declared under,
// whichever way the program reaches it: through an untyped value, through
// the class's prototype, held in a constant, printed, or bound.
class Kettle {
  boil(litres: number, degrees: number): string {
    return "boil " + litres + "/" + degrees;
  }
  pour(): number {
    return 0;
  }
  async steep(): Promise<number> {
    return 1;
  }
  *drip(): Generator<number> {
    yield 1;
  }
  "two words"(): number {
    return 2;
  }
  7(): number {
    return 7;
  }
  *[Symbol.iterator](): Generator<number> {
    yield 3;
  }
  whistle = (): string => "whistle";
}
class Samovar extends Kettle {
  boil(litres: number, degrees: number): string {
    return "samovar " + litres + degrees;
  }
}
abstract class Vessel {
  abstract volume(): number;
  describe(): string {
    return "vessel";
  }
}
class Jug extends Vessel {
  volume(): number {
    return 4;
  }
}

const loose: any = new Samovar();
const held = loose.boil;
console.log("untyped:", typeof held, held.name, loose.pour.name, loose.steep.name, loose.drip.name);
console.log("base:", (new Kettle() as any).boil.name);
console.log("keys:", loose["two words"].name, loose[7].name, loose[Symbol.iterator].name);
console.log("field:", loose.whistle.name);
console.log("printed:", loose.boil, loose.pour);

console.log("prototype:", Kettle.prototype.boil.name, Samovar.prototype.boil.name);
console.log("inherited:", Samovar.prototype.pour.name, Samovar.prototype.pour === Kettle.prototype.pour);
console.log("kinds:", Kettle.prototype.steep.name, Kettle.prototype["two words"].name);

const samovar = new Samovar();
const seen: Kettle = samovar;
interface Boiler {
  boil(litres: number, degrees: number): string;
}
const boiler: Boiler = samovar;
console.log("typed:", samovar.boil.name, seen.boil.name, boiler.boil.name);
console.log("bound:", samovar.boil.bind(samovar).name);
const descriptor = Object.getOwnPropertyDescriptor(loose.boil, "name");
console.log("descriptor:", descriptor?.value, descriptor?.writable, descriptor?.enumerable, descriptor?.configurable);

const jug: any = new Jug();
console.log("abstract:", jug.volume.name, jug.describe.name, Vessel.prototype.describe.name);
// The method is still the method.
console.log("called:", held.call(loose, 2, 90), loose.boil(1, 80));
