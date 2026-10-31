// [util.inspect.custom] methods keep their boundaries: a class whose
// subclass declares the method without declaring it itself, a method with
// more than three parameters, a method returning a class instance, and %o
// over instances with one.
import { format, inspect } from "node:util";

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

class Shown {
  [inspect.custom](): string {
    return "shown";
  }
}
console.log(format("%o", new Shown()));
