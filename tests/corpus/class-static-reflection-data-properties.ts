// Reflection on a class value answers from the class's own static data
// properties. Node reports every static field as a writable, enumerable,
// configurable DATA property (never an accessor), a field declared without
// an initializer exists with the value `undefined`, and a `#private` static
// is not a public key at all: reflection sees no trace of it, and a write
// through reflection cannot reach its storage.

class Registry {
  static readonly kind = "registry";
  static count = 3;
  static pending: number;
  static #secret = 41;
  // The private value as the class's own code reads it after any reflective
  // write: the class's storage, not the table's.
  static readSecret = (): number => Registry.#secret;
}

// Reflection reaches a class value the way outside code gets one: an
// untyped parameter.
function reflect(value: any): void {
  const count = Object.getOwnPropertyDescriptor(value, "count");
  console.log("count", count?.value, count?.writable, count?.enumerable, count?.configurable);

  const pending = Object.getOwnPropertyDescriptor(value, "pending");
  console.log("pending", "pending" in value, value.pending, pending?.value, pending?.writable);

  console.log("keys", Object.keys(value).sort().join(","));
  console.log("private", Reflect.ownKeys(value).includes("#secret"), value["#secret"]);

  value["#secret"] = 99;
  value.pending = 5;
  value.count = 7;
  console.log("after", value["#secret"], value.pending, value.count);
}

reflect(Registry);
// The write through the class value reached the storage the class's own
// code reads, and the private static kept its value.
console.log("native", Registry.count, Registry.readSecret());
