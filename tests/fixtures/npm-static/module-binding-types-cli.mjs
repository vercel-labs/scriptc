// Module bindings of a package that start as null or undefined and later
// hold typed values: reads and writes before, between, and after.
import writer from "chunk-writer";

console.log(writer.state());
console.log(writer.report());
try {
  writer.encodedTail(0);
} catch (e) {
  console.log(e.constructor.name, e.message);
}
console.log(writer.encode("héllo"), writer.encodedTail(2));
try {
  writer.viewLength();
} catch (e) {
  console.log(e.constructor.name, e.message);
}
writer.start();
writer.write([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
console.log(writer.state(), writer.viewLength());
console.log(writer.finish());
console.log(writer.fail("boom"), writer.state());
try {
  writer.finish();
} catch (e) {
  console.log(e.constructor.name, e.message);
}
