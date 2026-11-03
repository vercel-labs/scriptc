// [util.inspect.custom] methods keep their boundaries: a class whose
// subclass declares the method without declaring it itself, a method with
// more than three parameters, and a method returning a class instance.
import { inspect } from "node:util";

class Plain {
  a = 1;
}
class Fancy extends Plain {
  [inspect.custom](): string {
    return "fancy";
  }
}
const items: Plain[] = [new Fancy()];
console.log(inspect(items));

class Wide {
  [inspect.custom](a: number, b: unknown, c: unknown, d: unknown): string {
    return `${a}${String(b)}${String(c)}${String(d)}`;
  }
}
console.log(inspect(new Wide()));

class Echo {
  [inspect.custom](): Echo {
    return new Echo();
  }
}
console.log(inspect(new Echo()));
