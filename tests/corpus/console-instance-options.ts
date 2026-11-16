// Console construction options: groupIndentation (validated like Node's
// validateInteger, 0..1000), colorMode ('auto' and false both accepted),
// unknown keys ignored while their initializers still evaluate in source
// order, stderr defaulting to stdout, and Node's writable-stream errors.
import { Console } from "node:console";
import { Writable } from "node:stream";

function collector(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, chunks };
}

const out = collector();
const four = new Console({ stdout: out.stream, groupIndentation: 4 });
four.group();
four.log("four spaces");
four.group();
four.log("eight spaces");
const zero = new Console({ stdout: out.stream, groupIndentation: 0 });
zero.group();
zero.log("no indent");
console.log(JSON.stringify(out.chunks.join("")));

const both = collector();
const auto = new Console({ stdout: both.stream, colorMode: "auto" });
auto.log({ a: 1 });
const off = new Console({ stdout: both.stream, colorMode: false });
off.log({ a: 1 });
console.log(JSON.stringify(both.chunks.join("")));

const order: string[] = [];
const flag = (label: string, value: number): number => {
  order.push(label);
  return value;
};
const extra = new Console({
  unknown: flag("unknown", 1),
  groupIndentation: flag("groupIndentation", 2),
  stdout: out.stream,
  ignoreErrors: flag("ignoreErrors", 1) === 1,
  another: flag("another", 2),
});
extra.group();
extra.log("extra");
console.log(order.join(","));

for (const bad of [-1, 1001, 1.5]) {
  try {
    new Console({ stdout: out.stream, groupIndentation: bad });
    console.log("no throw", bad);
  } catch (error) {
    const e = error as Error & { code: string };
    console.log(e.code, e.message);
  }
}

try {
  new Console({});
} catch (error) {
  const e = error as Error & { code: string };
  console.log(e.code, e.message);
}
try {
  new Console({ stdout: out.stream, stderr: 1 });
} catch (error) {
  const e = error as Error & { code: string };
  console.log(e.code, e.message);
}
