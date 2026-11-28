export {};
// util.inspect of a class value named directly prints the class's source
// name, not the internal scoped name a function-local class carries. The
// literal must not contain `%c`, which console.log would read as a format
// directive.
import { inspect } from "node:util";

function names(): string[] {
  class Base {}
  class Point extends Base {}
  return [inspect(Point), inspect(Base), inspect(Point.name)];
}

for (const line of names()) console.log(line);
