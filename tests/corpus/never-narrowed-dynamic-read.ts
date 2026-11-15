// A failed negative type predicate narrows the value to never, and reads
// of it must still see the live value. The predicate type here is a type
// parameter that resolves to `unknown` (typebox's `Validator` reaches the
// same shape through `ReturnType<typeof Compile>`), so excluding it from
// the dynamic value leaves checker flow with no members at all.
class Box<Encode extends unknown = unknown> {
  Check(value: unknown): value is Encode {
    return typeof value === "object" && value !== null;
  }
  Errors(value: unknown): string[] {
    return [`got ${typeof value}`];
  }
}

function validate(args: unknown): string {
  const box = new Box();
  if (box.Check(args)) return "ok";
  // `args` is `never` on this path.
  return box.Errors(args).join(",");
}

console.log(validate({ a: 1 }));
console.log(validate(42));
console.log(validate("text"));
console.log(validate(null));
console.log(validate(undefined));
