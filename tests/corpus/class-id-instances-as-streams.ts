// Instances of a class hierarchy, held as untyped values, where the stream
// adapters probe for a native stream: pipe, pipeline, readline, and
// instanceof checks against the stream classes. Their first field is a
// number, which sits where a stream's vtable word would be.
import { Duplex, PassThrough, Readable, Transform, Writable, pipeline } from "node:stream";
import { createInterface } from "node:readline";

class Shape {
  size = 3.5;
  area(): number {
    return 0;
  }
}
class Square extends Shape {
  override area(): number {
    return this.size * this.size;
  }
}

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, "throws", error instanceof Error);
  }
}

const shape: any = new Square();
try {
  Readable.from(["a"]).pipe(shape);
} catch (error) {
  console.log("pipe", (error as Error).name);
}
attempt("pipeline", () => pipeline(shape, new PassThrough(), () => {}));
attempt("readline-input", () => createInterface({ input: shape }));
console.log("instanceof", shape instanceof Readable, shape instanceof Writable, shape instanceof Duplex);
console.log("instanceof-transform", shape instanceof Transform, shape instanceof PassThrough);
console.log("area", (shape as Square).area());
