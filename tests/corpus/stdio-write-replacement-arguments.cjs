// A replaced process.stdout.write or process.stderr.write sees the call's own
// arguments: arguments.length is the number the caller passed, whatever the
// replacement declares.
const seen = [];
const originalOut = process.stdout.write;
process.stdout.write = function (chunk, encodingOrCallback, callback) {
  seen.push(`stdout declared3 ${arguments.length} ${typeof callback}`);
  return true;
};
process.stdout.write("one");
process.stdout.write("two", "utf8");
process.stdout.write("three", "utf8", () => {});
process.stdout.write = function () {
  seen.push(`stdout declared0 ${arguments.length} ${arguments[0]}`);
  return true;
};
process.stdout.write("zero");
process.stdout.write = function (chunk) {
  seen.push(`stdout declared1 ${arguments.length} ${arguments[1]}`);
  return true;
};
process.stdout.write("a", "latin1");
process.stdout.write = originalOut;
const originalErr = process.stderr.write;
process.stderr.write = function (chunk, encodingOrCallback, callback) {
  seen.push(`stderr declared3 ${arguments.length} ${typeof callback}`);
  return true;
};
process.stderr.write("one");
process.stderr.write("two", "utf8");
process.stderr.write("three", "utf8", () => {});
process.stderr.write = function () {
  seen.push(`stderr declared0 ${arguments.length} ${arguments[0]}`);
  return true;
};
process.stderr.write("zero");
process.stderr.write = function (chunk) {
  seen.push(`stderr declared1 ${arguments.length} ${arguments[1]}`);
  return true;
};
process.stderr.write("a", "latin1");
process.stderr.write = originalErr;
console.log(seen.join("\n"));
