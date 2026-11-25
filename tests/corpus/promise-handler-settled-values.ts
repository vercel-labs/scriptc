// `.then(onFulfilled, onRejected)` and `.catch(onRejected)` hand the settled
// value on after the await that the rejection handler guards: the value is
// read after that guarded region ends, for every kind of value, whether the
// promise was already settled or settles later, and when nothing else keeps
// the value.
interface Reading {
  station: string;
  level: number;
}
class Gauge {
  id: string;
  marks: number[];
  constructor(id: string, marks: number[]) {
    this.id = id;
    this.marks = marks;
  }
  total(): number {
    return this.marks.reduce((a, b) => a + b, 0);
  }
}
function soon<T>(make: () => T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(make()), 1));
}
function fails(reason: string): Promise<string> {
  return new Promise<string>((_, reject) => setTimeout(() => reject(new Error(reason)), 1));
}
const text = (i: number): string => "level-" + String(i * 13);
const reading = (i: number): Reading => ({ station: "st-" + String(i), level: i * 4 });
const gauge = (i: number): Gauge => new Gauge("g" + String(i), [i, i + 1, i + 2]);
const list = (i: number): string[] => ["a" + String(i), "b" + String(i)];
const loose = (i: number): unknown => JSON.parse('{"n":' + String(i) + ',"tags":["p"]}');

async function main(): Promise<void> {
  const out: string[] = [];
  const bad = (e: unknown): string => "bad " + (e as Error).message;
  for (let i = 1; i <= 2; i++) {
    out.push(await Promise.resolve(text(i)).then((v) => "now " + v, bad));
    out.push(await soon(() => text(i)).then((v) => "soon " + v, bad));
    out.push(await soon(() => reading(i)).then((v) => v.station + ":" + String(v.level), bad));
    out.push(await soon(() => gauge(i)).then((v) => v.id + "=" + String(v.total()), bad));
    out.push(await soon(() => list(i)).then((v) => v.join("|"), bad));
    out.push(await soon(() => loose(i)).then((v) => JSON.stringify(v), bad));
    out.push(await fails("late " + String(i)).then((v) => "kept " + v, bad));
    // No fulfillment handler: the settled value itself is the result.
    out.push(await soon(() => text(i + 5)).catch(bad));
    const passed = await soon(() => reading(i + 5)).catch(() => reading(0));
    out.push(passed.station + ":" + String(passed.level));
    const marks = await soon(() => gauge(i + 5)).then(undefined, () => gauge(0));
    out.push(marks.id + "=" + String(marks.total()));
    out.push(await fails("lost " + String(i)).catch(bad));
    // The fulfillment handler throws: the rejection handler of the same
    // call does not see it.
    out.push(
      await soon(() => list(i))
        .then(
          (v): string => {
            throw new Error("thrown with " + v.join("|"));
          },
          () => "wrong handler",
        )
        .catch(bad),
    );
  }
  console.log(out.join("\n"));
}
void main();
