import { publish } from "@scriptc/threads";

interface Point { x: number; live: boolean }
function makePoint(n: number): Point { return { x: n, live: true }; }
function forwardPoint(n: number): Point { return makePoint(n); }
function shift(point: Point): void { point.x += 1; }
class Meter {
  value: number;
  constructor(n: number) { this.value = n; }
}
function makeMeter(n: number): Meter { return new Meter(n); }

const shared = publish({ point: makePoint(1), meter: makeMeter(2) });

function recordWrites(n: number): number {
  const direct: Point = { x: n, live: true };
  shift(direct);
  const produced = forwardPoint(n);
  shift(produced);
  return direct.x + produced.x;
}
function classWrites(n: number): number {
  const direct = new Meter(n);
  direct.value = n + 1;
  let produced = makeMeter(n);
  produced.value = n + 2;
  produced = makeMeter(produced.value);
  produced.value += 1;
  return direct.value + produced.value;
}
function readProduced(n: number): number {
  // Result-slot initialization itself must not trip a publication guard.
  const value = makePoint(n);
  return value.x + (value.live ? 1 : 0);
}
function report(label: string, run: () => number): void {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, error instanceof TypeError ? "TypeError" : "other error");
  }
}

report("record writes", () => recordWrites(3));
report("class writes", () => classWrites(4));
report("produced read", () => readProduced(5));
report("direct arguments", () => {
  shift({ x: 2, live: true });
  shift(makePoint(3));
  return 1;
});
report("published record", () => {
  shift(shared.point);
  return shared.point.x;
});
report("published class", () => {
  shared.meter.value = 9;
  return shared.meter.value;
});
console.log("unchanged", shared.point.x, shared.meter.value);
