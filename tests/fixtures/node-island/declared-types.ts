// A failed build whose package runs in a Node island reports the island
// build's errors: there the package's declarations type the program. The
// test builds it beside corpus 6829's schemakit package.
import { Num, check, type Static, type TNumber, type TSchema } from "schemakit";

interface Tool<T extends TSchema = TSchema> {
  name: string;
  parameters: T;
  execute(id: string, params: Static<T>): string;
}

const double: Tool<TNumber> = {
  name: "double",
  parameters: Num(),
  execute: (id, params) => `${id}: ${params * 2}`,
};
const input: unknown = 4;
if (check(double.parameters, input)) console.log(double.execute(double.name, input));
// The build's own error: member decorators have no native lowering.
function logged(method: () => number, context: ClassMethodDecoratorContext): void {}
class Counter {
  @logged
  next(): number {
    return 1;
  }
}
console.log(new Counter().next());
