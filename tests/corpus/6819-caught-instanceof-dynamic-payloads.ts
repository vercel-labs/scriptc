// `e instanceof C` on a catch binding when the thrown value crossed into
// unknown first: a union, an unknown or any value, a rethrown binding and an
// awaited rejection. The narrowed reads and `e as C` read the same instance.
abstract class Shape {
  sides = 0;
}
class Polygon extends Shape {
  name = "polygon";
}
class Square extends Polygon {
  size = 3;
}
class Plain {
  w = 4;
}
class CodedError extends Error {
  code = 7;
}

function report(label: string, e: unknown): void {
  console.log(label, "via unknown", e instanceof Shape, e instanceof Polygon, e instanceof Square, e instanceof Plain);
}

function attempt(label: string, body: () => void): void {
  try {
    body();
  } catch (e) {
    report(label, e);
    console.log(label, "binding", e instanceof Shape, e instanceof Polygon, e instanceof Square, e instanceof Plain, e instanceof Error, e instanceof CodedError);
    console.log(label, "negated", !(e instanceof Shape), !(e instanceof Error));
    if (e instanceof Polygon) console.log(label, "narrowed", e.name, e.sides);
    if (e instanceof Square) console.log(label, "square", e.size);
    if (e instanceof CodedError) console.log(label, "coded", e.code, e.message);
    if (e instanceof Shape && !(e instanceof Square)) console.log(label, "shape only", (e as Polygon).name);
  }
}

function throwUnknown(value: unknown): never {
  throw value;
}
const choose = (n: number): Polygon | Plain | string => (n === 0 ? new Square() : n === 1 ? new Plain() : n === 2 ? new Polygon() : "text");
const maybe = (n: number): Square | undefined => (n === 0 ? new Square() : undefined);
const failure = (n: number): CodedError | string => (n === 0 ? new CodedError("failed") : "failed");

for (let n = 0; n < 4; n++) attempt(`union ${n}`, () => { throw choose(n); });
attempt("optional", () => { throw maybe(0); });
attempt("optional undefined", () => { throw maybe(1); });
attempt("error union", () => { throw failure(0); });
attempt("error union string", () => { throw failure(1); });
attempt("unknown", () => throwUnknown(new Square()));
attempt("unknown plain", () => throwUnknown(new Plain()));
attempt("unknown error", () => throwUnknown(new CodedError("unknown")));
const anyValue: any = new Polygon();
attempt("any", () => { throw anyValue; });
attempt("typed", () => { const shape: Shape = new Square(); throw shape; });
attempt("rethrow", () => {
  try {
    throw choose(0);
  } catch (inner) {
    throw inner;
  }
});

async function main(): Promise<void> {
  try {
    await Promise.reject(choose(0));
  } catch (e) {
    console.log("rejected", e instanceof Shape, e instanceof Polygon, e instanceof Square, e instanceof Plain);
    if (e instanceof Square) console.log("rejected square", e.size, e.name);
  }
  try {
    await (async () => {
      throw failure(0);
    })();
  } catch (e) {
    console.log("async error", e instanceof Error, e instanceof CodedError);
    if (e instanceof CodedError) console.log("async coded", e.code);
  }
}
void main();
