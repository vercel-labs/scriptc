import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

function show(label: string, values: (number | string)[]): void {
  console.log(label, JSON.stringify(values));
}

const a = createHistogram();
for (const value of [5, 10, 10, 100, 1000, 7]) a.record(value);
const b = createHistogram();
for (const value of [6, 11, 12, 90, 1100, 8]) b.record(value);

show("ks", [Number(a.ksTest(b).toFixed(6)), Number(b.ksTest(a).toFixed(6))]);
show("cohen", [Number(a.cohensD(b).toFixed(6)), Number(b.cohensD(a).toFixed(6))]);
show("cliff", [Number(a.cliffsD(b).toFixed(6)), Number(b.cliffsD(a).toFixed(6))]);

const mw = a.mannWhitneyTest(b);
show("mw keys", Object.keys(mw));
show("mw", [mw.uStatistic, Number(mw.zScore.toFixed(6)), Number(mw.pValue.toFixed(6))]);
const reverse = b.mannWhitneyTest(a);
show("mw reverse", [reverse.uStatistic, Number(reverse.zScore.toFixed(6)), Number(reverse.pValue.toFixed(6))]);

// Comparing a histogram with itself answers zeros (and the normal
// approximation's U of 0, z of 0 and p of 1).
show("self", [a.ksTest(a), a.cohensD(a), a.cliffsD(a)]);
const self = a.mannWhitneyTest(a);
show("self mw", [self.uStatistic, self.zScore, self.pValue]);

// An empty side makes every comparison answer its neutral value.
const empty = createHistogram();
show("empty", [
  empty.ksTest(a),
  a.ksTest(empty),
  empty.cohensD(a),
  a.cohensD(empty),
  empty.cliffsD(a),
  a.cliffsD(empty),
]);
const emptyFirst = empty.mannWhitneyTest(a);
show("empty mw", [emptyFirst.uStatistic, emptyFirst.zScore, emptyFirst.pValue]);
const emptySecond = a.mannWhitneyTest(empty);
show("empty mw reverse", [emptySecond.uStatistic, emptySecond.zScore, emptySecond.pValue]);

// An IntervalHistogram is a Histogram too: the same comparisons lower for it.
const eld = monitorEventLoopDelay();
show("eld self", [eld.ksTest(eld), eld.cohensD(eld), eld.cliffsD(eld)]);
const eldMw = eld.mannWhitneyTest(eld);
show("eld self mw", [eldMw.uStatistic, eldMw.zScore, eldMw.pValue]);
eld.disable();

// A non-histogram `other` is Node's ERR_INVALID_ARG_TYPE naming the value.
function showError(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    console.log(label, e.name, e.code ?? "", JSON.stringify(e.message));
  }
}
showError("ks number", () => a.ksTest(5 as any));
showError("cohen null", () => a.cohensD(null as any));
showError("cliff string", () => a.cliffsD("x" as any));
showError("mw number", () => a.mannWhitneyTest(5 as any));
