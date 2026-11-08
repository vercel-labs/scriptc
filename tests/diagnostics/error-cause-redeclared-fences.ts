// A redeclared Error cause compiles as a field of any type that compiles
// (the error's own cause, read at the declared type). A parameter property
// or an accessor named `cause` has no lowering.
class FromParameter extends Error {
  constructor(public override cause: unknown) {
    super("parameter");
  }
}
class Accessor extends Error {
  override get cause(): unknown {
    return "accessor";
  }
}
console.log(new FromParameter(1).cause);
console.log(new Accessor("a").cause);
