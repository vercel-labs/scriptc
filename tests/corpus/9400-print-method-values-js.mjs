// Pins, for a JavaScript program: a method held in an array, a record, a
// Map or a Set prints as the method it is. A static method read through its
// class or through a subclass and an instance method carry their own names,
// async and generator methods their call kind, and the same name answers
// `name` and follows `bound`.
import { inspect } from "node:util";

class Thermo {
  static toKelvin(celsius) {
    return celsius + 273.15;
  }
  static async calibrate(offset) {
    return offset;
  }
  static *steps(limit) {
    for (let i = 0; i < limit; i++) yield i;
  }
  static async *samples(limit) {
    yield limit;
  }
  toFahrenheit(celsius) {
    return (celsius * 9) / 5 + 32;
  }
  half = (value) => value / 2;
  get rounder() {
    return function nearest(value) {
      return Math.round(value);
    };
  }
}
class Lab extends Thermo {
  static toRankine(celsius) {
    return (celsius + 273.15) * 1.8;
  }
}
const thermo = new Thermo();

const table = [Thermo.toKelvin, Lab.toKelvin, Lab.toRankine, thermo.toFahrenheit];
console.log(table);
console.log(inspect(table));
console.log(table.map((convert) => convert.name));
console.log(table.map((convert) => Math.round(convert(100))));
console.log([Thermo.calibrate, Thermo.steps, Thermo.samples]);
console.log({ label: "kelvin", run: Thermo.toKelvin }, Thermo.toKelvin, Lab.toKelvin);
console.log("label", Lab.toRankine, [Thermo.toKelvin]);
console.log([Thermo.toKelvin.bind(null), thermo.toFahrenheit.bind(thermo)]);
console.log([thermo.half, thermo.rounder]);

function show(value) {
  console.log(value);
  console.log(inspect(value));
}
show(Thermo.toKelvin);
show([Lab.toKelvin]);
show({ steps: [{ run: Thermo.steps }] });
