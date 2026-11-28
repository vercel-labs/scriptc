// Identifiers well past fifty characters: a function, an async function, a class with a long
// method, a constant, and a template interpolation that calls them. The native SDK's generated
// page modules rely on these names surviving whole, so this is the case it depends on.
function aFunctionNamedWithAVeryLongIdentifierForTheHarnessTest(a: number): number {
  return a + 1;
}

async function anAsyncFunctionNamedWithAnExtremelyLongIdentifierForTheTest(b: number): Promise<number> {
  return b + 2;
}

class aClassNamedWithAnExtremelyLongIdentifierNameForTheHarnessCase {
  private value: number = 7;
  anInstanceMethodWithAnExtremelyLongIdentifierNameToo(): number {
    return this.value;
  }
}

const aConstantNamedWithAnExtremelyLongIdentifierForTheHarnessCase: number = 10;

async function main(): Promise<void> {
  const instance = new aClassNamedWithAnExtremelyLongIdentifierNameForTheHarnessCase();
  console.log("plain=" + aFunctionNamedWithAVeryLongIdentifierForTheHarnessTest(1));
  console.log("async=" + (await anAsyncFunctionNamedWithAnExtremelyLongIdentifierForTheTest(1)));
  console.log("method=" + instance.anInstanceMethodWithAnExtremelyLongIdentifierNameToo());
  console.log("constant=" + aConstantNamedWithAnExtremelyLongIdentifierForTheHarnessCase);
  const interpolated = `${aFunctionNamedWithAVeryLongIdentifierForTheHarnessTest(2)}`;
  console.log("interpolated=" + interpolated);
}

main();
