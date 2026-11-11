// The global Buffer binding, reached without an import: the class is a value
// in the program's type space, and every documented static constructor and
// the instance methods run through it. The node:buffer programs prove the
// same surface through the module's exports; this program proves the global
// spelling that TypeScript sources use without importing anything.
function hex(value: Buffer): string {
  return value.toString("hex");
}

console.log(typeof Buffer, Buffer.name, Buffer.length);

// from over the source kinds.
console.log(hex(Buffer.from("héllo")), Buffer.from("héllo").length);
console.log(hex(Buffer.from("6162ff", "hex")), hex(Buffer.from("aGk=", "base64")));
console.log(hex(Buffer.from([0, 1, 255, 256, -1, 1.9])));
console.log(hex(Buffer.from(new Uint8Array([3, 4, 5]))));
console.log(hex(Buffer.from(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)));
console.log(hex(Buffer.of(1, 2, 255)));

// alloc and the unsafe pair.
console.log(Buffer.alloc(3, 65).toString(), Buffer.alloc(4).toString("hex"));
console.log(Buffer.allocUnsafe(2).length, Buffer.allocUnsafeSlow(3).length);

// concat with and without a total length.
console.log(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString());
console.log(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], 3).toString());

// byteLength over the documented sources.
console.log(
  Buffer.byteLength("héllo"),
  Buffer.byteLength("aGk=", "base64"),
  Buffer.byteLength(new Uint16Array(3)),
);

// The predicates and the comparison.
console.log(
  Buffer.isBuffer(Buffer.from("x")),
  Buffer.isBuffer(new Uint8Array(1)),
  Buffer.isEncoding("UTF-8"),
  Buffer.isEncoding("nope"),
);
console.log(Buffer.compare(Buffer.from("a"), Buffer.from("b")));

// Instance reads and methods through the global's result, including through
// a local alias of the constructor.
const made = Buffer.from("abc");
console.log(made.length, made[1], made.subarray(1).toString(), made.slice(0, 2).toString());
console.log(made instanceof Buffer, made.equals(Buffer.from("abc")));
console.log(String(Buffer.from("ab")), made.toJSON());

const Alias = Buffer;
console.log(Alias.from("z").toString(), Alias.isBuffer(made));

// Passing the class through a helper typed with its constructor type is a
// held constructor value, which the compiler refuses; passing the values it
// builds is the documented way.
function lengthOf(value: Buffer): number {
  return value.length;
}
console.log(lengthOf(made), lengthOf(Buffer.alloc(5)));
