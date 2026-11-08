// `name` and `message` of an error read through an intersection type that
// restates the member as optional (`Error & { name?: string }`, what an
// assertion or a type guard leaves): the value is the error itself, so the
// read answers what the error answers, a subclass's own name included.
class StockError extends Error {
  bin: string;
  constructor(message: string, bin: string) {
    super(message);
    this.name = "StockError";
    this.bin = bin;
  }
}
function isNamed(e: Error): e is Error & { name?: string } {
  return e.message.length > 0;
}
function label(err: Error & { name?: string }): string {
  return err.name === "StockError" ? "stock" : `other:${err.name}`;
}

const base = new RangeError("too deep");
console.log((base as Error & { name?: string }).name);
console.log((base as Error & { message?: string }).message);
if (isNamed(base)) console.log(base.name, base.message);

const stock = new StockError("empty", "north");
console.log(label(stock), label(base));
console.log((stock as StockError & { name?: string }).name, stock.bin);

try {
  throw stock;
} catch (e) {
  if (e instanceof Error) {
    const named: Error & { name?: string } = e;
    console.log(named.name, named.name === "StockError", named.message);
  }
}

// A name assigned later is the one read.
const renamed = new Error("moved") as Error & { name?: string };
renamed.name = "MovedError";
console.log(renamed.name, String(renamed));
