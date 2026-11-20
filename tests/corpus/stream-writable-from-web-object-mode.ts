// Writable.fromWeb with objectMode: a typed record, an array and a class
// instance each reach the web sink as the value the program wrote. The typed
// record travels through its stream descriptor, not as a checked-dynamic
// value, so the adapter has to box it with that descriptor.
import { Writable } from "node:stream";

interface Point {
  x: number;
  y: number;
}

class Box {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}

const log: string[] = [];

function drain(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

async function main(): Promise<void> {
  const seen: string[] = [];
  const web = new WritableStream<unknown>({
    write(chunk) {
      if (typeof chunk === "object" && chunk !== null && "x" in (chunk as object)) {
        seen.push(`point:${(chunk as Point).x},${(chunk as Point).y}`);
      } else if (Array.isArray(chunk)) {
        seen.push(`array:${chunk.length}`);
      } else if (chunk instanceof Box) {
        seen.push(`box:${chunk.n}`);
      } else {
        seen.push(String(chunk));
      }
    },
  });
  const writable = Writable.fromWeb(web, { objectMode: true });

  const point: Point = { x: 1, y: 2 };
  log.push(`record write ${writable.write(point)}`);
  await drain();
  log.push(`record ${seen.join("|")} fields ${point.x},${point.y}`);

  log.push(`array write ${writable.write([1, 2] as unknown)}`);
  await drain();
  log.push(`array ${seen.join("|")}`);

  log.push(`class write ${writable.write(new Box(3) as unknown)}`);
  await drain();
  log.push(`class ${seen.join("|")}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
