// Object.setPrototypeOf and Object.create reject a prototype that is
// neither an object nor null with Node's TypeError, whose message ends with
// the value's string form: numbers as String(n) (-0 as 0), bigints without
// the n suffix, symbols as Symbol(description), and the empty string as
// nothing.

function message(run: () => unknown): string {
  try {
    run();
    return "no error";
  } catch (error) {
    return `${error instanceof TypeError} ${(error as Error).message}`;
  }
}

const prototypes: [string, unknown][] = [
  ["number", 7],
  ["fraction", 1.5],
  ["negative zero", -0],
  ["nan", NaN],
  ["string", "proto"],
  ["empty string", ""],
  ["boolean", true],
  ["undefined", undefined],
  ["bigint", 10n],
  ["symbol", Symbol("tag")],
];

for (const [label, prototype] of prototypes) {
  const invalid = prototype as object | null;
  const target: unknown = JSON.parse('{"own":1}');
  console.log(label, "object receiver |", message(() => Object.setPrototypeOf(target, invalid)));
  console.log(label, "primitive receiver |", message(() => Object.setPrototypeOf(5, invalid)));
  console.log(label, "create |", message(() => Object.create(invalid)));
}

const valid: unknown = JSON.parse('{"own":1}');
console.log("null prototype |", message(() => Object.setPrototypeOf(valid, null)));
console.log("object prototype |", message(() => Object.create({ inherited: true })));
