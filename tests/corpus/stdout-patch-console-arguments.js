// What a replaced process.stdout.write receives from console: Node's
// console writes each formatted line with stream.write(line, errorHandler),
// so the replacement sees a string and a function as its second argument
// for console.log, info, debug, dir, count, table and grouped lines alike;
// a direct write passes exactly its own arguments. The error handler accepts
// a null error.
const original = process.stdout.write;
const seen = [];
process.stdout.write = function (chunk, encodingOrCallback, callback) {
  const kind = typeof chunk === "string" ? "string" : Buffer.isBuffer(chunk) ? "Buffer" : chunk.constructor.name;
  seen.push(`${kind}:${JSON.stringify(String(chunk))}:${typeof encodingOrCallback}:${typeof callback}`);
  if (typeof encodingOrCallback === "function") encodingOrCallback(null);
  return true;
};
console.log("line", 1);
console.info("info");
console.debug("debug");
console.log("%s=%d", "x", 2);
console.dir({ a: 1 });
console.count();
console.group("group");
console.log("inside");
console.groupEnd();
console.table([{ a: 1 }]);
process.stdout.write("direct");
process.stdout.write("hex", "utf8");
process.stdout.write(Buffer.from("bytes"));
process.stdout.write = original;
console.log(seen.join("\n"));
