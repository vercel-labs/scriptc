// perf_hooks Histogram inference: the confidence interval for the mean and a
// percentile (Student's t and the exact binomial method) and Welch's t-test,
// over the same hdr_histogram readings the other getters answer.
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

function round(value: number): number {
  return Number(value.toFixed(6));
}

function showError(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    console.log(label, e.name, e.code ?? "", JSON.stringify(e.message));
  }
}

const a = createHistogram();
for (const value of [10, 20, 30, 40, 50]) a.record(value);
const b = createHistogram();
for (const value of [12, 22, 33, 45, 60]) b.record(value);

const meanCI = a.meanCI();
console.log("mean", meanCI.mean, round(meanCI.lower), round(meanCI.upper));
const meanCI90 = a.meanCI({ confidence: 0.9 });
console.log("mean 90", meanCI90.mean, round(meanCI90.lower), round(meanCI90.upper));

const pci = a.percentileCI(50);
console.log("pci", pci.value, pci.lower, pci.upper);
const pci90 = a.percentileCI(90.5, { confidence: 0.9 });
console.log("pci 90", pci90.value, pci90.lower, pci90.upper);
const pciEdge = a.percentileCI(100);
console.log("pci 100", pciEdge.value, pciEdge.lower, pciEdge.upper);

const welch = a.welchTest(b);
console.log(
  "welch",
  round(welch.tStatistic),
  round(welch.degreesOfFreedom),
  round(welch.pValue),
  round(welch.confidenceInterval.lower),
  round(welch.confidenceInterval.upper),
);
const welch99 = b.welchTest(a, { confidence: 0.99 });
console.log(
  "welch 99",
  round(welch99.tStatistic),
  round(welch99.degreesOfFreedom),
  round(welch99.pValue),
  round(welch99.confidenceInterval.lower),
  round(welch99.confidenceInterval.upper),
);

const self = a.welchTest(a);
console.log(
  "self",
  self.tStatistic,
  self.degreesOfFreedom,
  self.pValue,
  self.confidenceInterval.lower,
  self.confidenceInterval.upper,
);

const empty = createHistogram();
const emptyMean = empty.meanCI();
console.log("empty mean", emptyMean.mean, emptyMean.lower, emptyMean.upper);
const emptyPci = empty.percentileCI(50);
console.log("empty pci", emptyPci.value, emptyPci.lower, emptyPci.upper);
const emptyWelch = empty.welchTest(a);
console.log("empty welch", emptyWelch.tStatistic, emptyWelch.pValue);
const emptyWelch2 = a.welchTest(empty);
console.log("empty welch 2", emptyWelch2.tStatistic, emptyWelch2.pValue);

const one = createHistogram();
one.record(7);
const oneMean = one.meanCI();
console.log("one mean", oneMean.mean, oneMean.lower, oneMean.upper);
const onePci = one.percentileCI(50);
console.log("one pci", onePci.value, onePci.lower, onePci.upper);

const flat = createHistogram();
for (const value of [5, 5, 5, 5]) flat.record(value);
const flatMean = flat.meanCI();
console.log("flat mean", flatMean.mean, flatMean.lower, flatMean.upper);

// Validation: Node's order is the receiver, the percentile (percentileCI),
// the other histogram (welchTest), then the options object.
for (const confidence of [0, 1, -0.5, 1.5, NaN, Infinity]) {
  showError(`mean confidence ${confidence}`, () => a.meanCI({ confidence }));
}
showError("mean confidence string", () => a.meanCI({ confidence: "0.5" as any }));
showError("mean options number", () => a.meanCI(5 as any));
showError("mean options null", () => a.meanCI(null as any));

for (const percentile of [0, -1, 101, NaN]) {
  showError(`pci percentile ${percentile}`, () => a.percentileCI(percentile));
}
showError("pci percentile string", () => a.percentileCI("50" as any));
showError("pci confidence", () => a.percentileCI(50, { confidence: 1 }));

showError("welch other number", () => a.welchTest(5 as any));
showError("welch other null", () => a.welchTest(null as any));
showError("welch other first", () => a.welchTest(5 as any, { confidence: 0 }));
showError("welch confidence", () => a.welchTest(b, { confidence: 2 }));

// An empty monitorEventLoopDelay histogram answers its interval-histogram
// percentile (511) for every percentileCI field, unlike a recordable
// histogram's zero.
const interval = monitorEventLoopDelay({ resolution: 20 });
interval.disable();
const intervalPci = interval.percentileCI(50);
console.log("eld pci", intervalPci.value, intervalPci.lower, intervalPci.upper);
const intervalPci90 = interval.percentileCI(90.5, { confidence: 0.9 });
console.log("eld pci 90", intervalPci90.value, intervalPci90.lower, intervalPci90.upper);

// Every argument expression runs before the method validates anything, so an
// options expression's side effects happen and its throw wins.
let effects = 0;
function options(): { confidence: number } {
  effects++;
  return { confidence: 0.9 };
}
showError("pci order", () => a.percentileCI(0, options()));
console.log("pci effects", effects);
showError("welch order", () => a.welchTest(5 as any, options()));
console.log("welch effects", effects);
function throwingOptions(): { confidence: number } {
  throw new Error("options threw");
}
showError("pci options throw", () => a.percentileCI(0, throwingOptions()));
showError("welch options throw", () => a.welchTest(5 as any, throwingOptions()));

