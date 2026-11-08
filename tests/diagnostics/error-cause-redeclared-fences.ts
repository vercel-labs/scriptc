// Redeclared Error causes compile when declared `unknown` or `object`. A
// narrower declared type would claim more than the checked-dynamic `cause`
// property proves, and a parameter property or an accessor named `cause`
// has no lowering.
class Typed extends Error {
  override cause?: Error;
}
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
console.log(new Typed("typed").cause);
console.log(new FromParameter(1).cause);
console.log(new Accessor("a").cause);
