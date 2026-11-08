// An Error subclass that declares `cause` again defines it with its other
// fields, at the declaration's position, enumerable, undefined until
// assigned. A cause the constructor's options created first is redefined
// in place instead, so it stays ahead of the fields.
class Blight extends Error {
  plot = 7;
  cause?: unknown;
  row = 2;
}

class Mildew extends Error {
  plot = 3;
  cause?: unknown;
  row = 1;
  constructor(message: string, reason?: unknown) {
    super(message);
    if (reason !== undefined) this.cause = reason;
  }
}

class Rust extends Error {
  cause: unknown = "spores";
  plot = 5;
}

function listed(error: Error): string {
  const own = error as object;
  return `${Object.keys(own).join(",")} | ${JSON.stringify(own)} | ${Object.getOwnPropertyNames(own).join(",")}`;
}

const absent = new Blight("absent");
console.log(listed(absent));
console.log(absent.cause, "cause" in absent, Object.hasOwn(absent, "cause"));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(absent, "cause")));

const later = new Blight("later");
later.cause = "rain";
console.log(listed(later), later.cause, (later as Error).cause);

const given = new Blight("given", { cause: "frost" });
console.log(listed(given));
console.log(given.cause, JSON.stringify(Object.getOwnPropertyDescriptor(given, "cause")));
given.cause = "thaw";
console.log(listed(given), given.cause);

console.log(listed(new Mildew("bare")));
console.log(listed(new Mildew("wet", "fog")));

const rust = new Rust("rust");
console.log(listed(rust), rust.cause);
rust.cause = new RangeError("damp");
console.log((rust.cause as Error).message, Object.keys(rust).join(","));

// Seen through an untyped reference and after a catch.
try {
  throw later;
} catch (caught) {
  console.log(Object.keys(caught as object).join(","), (caught as any).cause);
}
