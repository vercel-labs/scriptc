import { measure, type Factory, type Result } from "./measure.mjs";
import defaultMeasure from "./measure.mjs";
import * as measurements from "./measure.mjs";
import { offset, type Offset } from "./offset.js";
import { adjust } from "./adjust.cjs";
import { type Label, } from "./type-effect.mjs";
import { renamed, defaultRenamed, measure as starMeasure, type Measurement } from "./reexport.ts";

class Meter {
  amount: number;
  constructor(amount: number) { this.amount = amount; }
  read(): number { return this.amount; }
}

const factory: Factory = Meter;
const result: Result = measure(factory);
const amount: Offset = { value: offset };
const label: Label = { text: "typed" };
const other: Measurement = renamed(factory);
console.log(label.text, result.amount, measurements.measure(factory).amount);
console.log(adjust(result.amount + amount.value), other.amount);
console.log(measure === measurements.measure, renamed === measure);
console.log(defaultMeasure === measure, defaultRenamed === measure, starMeasure === measure);
