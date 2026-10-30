// A borrowed TypedArray.prototype.set over a DataView target throws Node's
// TypeError after evaluating its arguments, and leaves the view unchanged.
const view = new DataView(new ArrayBuffer(4));
const order: string[] = [];
function arg<T>(label: string, value: T): T {
  order.push(label);
  return value;
}
try {
  Uint8Array.prototype.set.call(arg("target", view), arg("source", [1, 2]), arg("offset", 1));
  console.log("set");
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message, order.join(","));
}
console.log(view.getUint8(1), view.getUint8(2));

function fill(target: DataView | Uint8Array, bytes: number[]): string {
  try {
    Uint8Array.prototype.set.call(target, bytes);
    return "set";
  } catch (e) {
    return (e as Error).message;
  }
}
console.log(fill(view, [7]), view.getUint8(0));
const bytes = new Uint8Array(2);
console.log(fill(bytes, [7]), bytes[0]);
const buffer = Buffer.alloc(3);
Uint8Array.prototype.set.call(buffer, [4, 5], 1);
console.log(buffer.toString("hex"));
