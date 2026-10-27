// Typed object-mode stream subclasses: Transform, Writable and Readable
// classes that pass objectMode to super(), _transform/_write/_read with
// record chunks, encoding parameters typed string | null | undefined, and
// push() of records and other values.
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

interface Order {
  id: number;
  items: string[];
}

interface Summary {
  id: number;
  count: number;
}

class Orders extends Readable {
  private next = 1;
  constructor() {
    super({ objectMode: true });
  }
  _read(): void {
    if (this.next > 3) {
      this.push(null);
      return;
    }
    const id = this.next++;
    this.push({ id, items: Array.from({ length: id }, (_, i) => `item${i}`) });
  }
}

class Summarize extends Transform {
  constructor() {
    super({ objectMode: true });
  }
  _transform(
    order: Order,
    encoding: string | null | undefined,
    cb: (err: Error | null, data?: Summary) => void,
  ): void {
    console.log("summarize", order.id, encoding);
    cb(null, { id: order.id, count: order.items.length });
  }
}

class Report extends Writable {
  lines: string[] = [];
  constructor() {
    super({ objectMode: true, highWaterMark: 1 });
  }
  _write(s: Summary, _encoding: string, cb: (err?: Error | null) => void): void {
    this.lines.push(`#${s.id}=${s.count}`);
    cb();
  }
}

async function main(): Promise<void> {
  const report = new Report();
  console.log("report", report.writableObjectMode, report.writableHighWaterMark);
  await pipeline(new Orders(), new Summarize(), report);
  console.log("lines", report.lines.join(" "));

  const direct = new Summarize();
  direct.on("data", (s: Summary) => console.log("direct", s.id, s.count));
  direct.write({ id: 9, items: ["a"] }, "utf8");
  direct.write({ id: 10, items: [] }, () => console.log("written"));
  direct.end();

  const values = new Readable({ objectMode: true, read() {} });
  values.push(1.5);
  values.push("text");
  values.push([1, 2]);
  values.push(null);
  const seen: string[] = [];
  for await (const v of values) seen.push(JSON.stringify(v));
  console.log("values", seen.join(" "));
}
main();
