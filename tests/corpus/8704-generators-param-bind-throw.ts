// A generator binds its parameters at the CALL: FunctionDeclarationInstantiation
// runs before GeneratorStart, so a nullish destructuring argument throws from
// the call itself, before any .next(), and the body never runs. Covers
// generator functions, object-literal generator methods and class generator
// methods (Test262's *-gen-method destructuring chapters).
interface Shape {
  a: number;
}

function* fromShape({ a }: Shape): Generator<number, void, unknown> {
  console.log("function body", a);
  yield a;
}

const shape = { a: 7 };
// Opaque to the frontend: the value really is null (or undefined) at run time.
function nullShape(): Shape | null {
  return null;
}
function undefinedShape(): Shape | undefined {
  return undefined;
}

// The call throws; nothing has been resumed.
try {
  fromShape(nullShape() as Shape);
  console.log("no throw");
} catch (e) {
  console.log("call threw", e instanceof TypeError);
}

// A successful binding still defers the body to the first .next().
const made = fromShape(shape);
console.log("created");
console.log(made.next().value as number);
console.log(made.next().done === true);

const methods = {
  *fromShape({ a }: Shape): Generator<number, void, unknown> {
    console.log("method body", a);
    yield a;
  },
};
try {
  methods.fromShape(nullShape() as Shape);
  console.log("no throw");
} catch (e) {
  console.log("method call threw", e instanceof TypeError);
}
const methodGen = methods.fromShape(shape);
console.log(methodGen.next().value as number);
console.log(methodGen.next().done === true);

class Box {
  *values({ a }: Shape): Generator<number, void, unknown> {
    console.log("class body", a);
    yield a;
  }
  static *make({ a }: Shape): Generator<number, void, unknown> {
    console.log("static body", a);
    yield a;
  }
}
const box = new Box();
try {
  box.values(nullShape() as Shape);
  console.log("no throw");
} catch (e) {
  console.log("class call threw", e instanceof TypeError);
}
try {
  Box.make(nullShape() as Shape);
  console.log("no throw");
} catch (e) {
  console.log("static call threw", e instanceof TypeError);
}
const instanceGen = box.values(shape);
console.log(instanceGen.next().value as number);
console.log(instanceGen.next().done === true);
const staticGen = Box.make(shape);
console.log(staticGen.next().value as number);
console.log(staticGen.next().done === true);

// undefined is not destructurable either — and neither is a primitive.
function* takesNumber({ a }: Shape): Generator<number, void, unknown> {
  yield a;
}
try {
  takesNumber(undefinedShape() as Shape);
} catch (e) {
  console.log("undefined threw", e instanceof TypeError);
}
console.log("done");
