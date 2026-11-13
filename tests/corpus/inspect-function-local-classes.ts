// util.inspect of a class declared inside a function prints the class's
// own name, `[class Point]` and `[class Derived extends Base]`, as Node
// does: the compiler's scoped internal name for the class never shows,
// for the class itself or for a base declared beside it.
import { inspect } from "node:util";

class Top {
  t = 0;
}
class Shadow {
  outer = 1;
}

function scope(): void {
  class Point {
    x = 1;
  }
  class Base {
    a = 1;
  }
  class Derived extends Base {
    b = 2;
  }
  class FromTop extends Top {
    c = 3;
  }
  class LocalError extends Error {}
  const Inferred = class {
    y = 1;
  };
  const Own = class Named {
    z = 1;
  };
  console.log(inspect(Point));
  console.log(inspect(Derived));
  console.log(inspect(Base), inspect(FromTop));
  console.log(inspect(LocalError));
  console.log(inspect(Inferred), inspect(Own));
  console.log(Point, [Derived], { cls: FromTop });
  console.log(inspect(new Point()), inspect(new Derived()));
  console.log(new Inferred().y, new Own().z, new LocalError("m").message);
}

function shadowing(): void {
  class Shadow {
    inner = 2;
  }
  console.log(inspect(Shadow), new Shadow().inner);
}

const nested = (): void => {
  function deeper(): void {
    class Leaf extends Top {
      l = 4;
    }
    console.log(inspect(Leaf), inspect(new Leaf()));
  }
  deeper();
};

scope();
shadowing();
console.log(inspect(Shadow), new Shadow().outer);
nested();
