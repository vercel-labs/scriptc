// util.isDeepStrictEqual reads each corresponding own enumerable property
// with a Get, so an accessor takes part by the value its getter answers: the
// getter runs once per object with the object as `this`, a non-enumerable
// accessor never runs, a setter-only property answers undefined, an answer
// that is an object is compared deeply, and a throwing getter's error
// reaches the caller.
import { isDeepStrictEqual as equal } from "node:util";

const show = (label: string, value: unknown): void => {
  console.log(`${label}: ${String(value)}`);
};

const attempt = (label: string, run: () => boolean): void => {
  try {
    show(label, run());
  } catch (error: any) {
    show(label, `threw ${error.name}: ${error.message}`);
  }
};

let runs = 0;
const accessor = (value: number): any => {
  const object: any = {};
  Object.defineProperty(object, "x", {
    enumerable: true,
    configurable: true,
    get() {
      runs += 1;
      return value;
    },
  });
  return object;
};

show("equal accessors", equal(accessor(42), accessor(42)));
show("getter runs", runs);
show("accessors differ", equal(accessor(42), accessor(43)));

show("accessor vs data", equal(accessor(5), { x: 5 }));
show("data vs accessor", equal({ x: 5 }, accessor(5)));
show("accessor vs undefined data", equal(accessor(5), { x: undefined }));

const seen: string[] = [];
const ordered = (name: string): any => {
  const object: any = {};
  for (const key of ["b", "a"]) {
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        seen.push(`${name}.${key}`);
        return key === "a" ? 1 : 2;
      },
    });
  }
  return object;
};
show("ordered accessors", equal(ordered("left"), ordered("right")));
show("getter order", seen.join(","));

// Key insertion order differs: Node walks the second object's keys, so the
// getters run in that order.
const reversed = (name: string): any => {
  const object: any = {};
  for (const key of ["a", "b"]) {
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        seen.push(`${name}.${key}`);
        return key === "a" ? 1 : 2;
      },
    });
  }
  return object;
};
seen.length = 0;
show("reordered accessors", equal(ordered("left"), reversed("right")));
show("getter order reordered", seen.join(","));

const borrowed: any = {};
Object.defineProperty(borrowed, "who", {
  enumerable: true,
  get() {
    return this.name;
  },
});
borrowed.name = "borrowed";
const sameBorrowed: any = {};
Object.defineProperty(sameBorrowed, "who", {
  enumerable: true,
  get() {
    return this.name;
  },
});
sameBorrowed.name = "borrowed";
show("getter receiver", equal(borrowed, sameBorrowed));
show("getter receiver differs", equal(borrowed, { who: "other", name: "borrowed" }));

let hiddenRuns = 0;
const hidden: any = { visible: 1 };
Object.defineProperty(hidden, "y", {
  enumerable: false,
  get() {
    hiddenRuns += 1;
    return 1;
  },
});
show("non-enumerable accessor", equal(hidden, { visible: 1 }));
show("non-enumerable getter runs", hiddenRuns);

const setterOnly: any = {};
Object.defineProperty(setterOnly, "z", {
  enumerable: true,
  set(value: number) {
    void value;
  },
});
show("setter-only accessor", equal(setterOnly, { z: undefined }));

const boom: any = {};
Object.defineProperty(boom, "x", {
  enumerable: true,
  get() {
    throw new RangeError("boom");
  },
});
attempt("throwing getter", () => equal(boom, { x: 1 }));

const thrownSecond: any = { x: 1 };
Object.defineProperty(thrownSecond, "x", {
  enumerable: true,
  get() {
    throw new TypeError("second");
  },
});
attempt("second object getter throws", () => equal({ x: 1 }, thrownSecond));

let countRuns = 0;
const guarded: any = {};
Object.defineProperty(guarded, "g", {
  enumerable: true,
  get() {
    countRuns += 1;
    return 1;
  },
});
show("key count first", equal(guarded, { g: 1, extra: 2 }));
show("key count stops getters", countRuns);

const deepAnswer: any = {};
Object.defineProperty(deepAnswer, "o", {
  enumerable: true,
  get() {
    return { n: [1, 2] };
  },
});
show("accessor deep answer", equal(deepAnswer, { o: { n: [1, 2] } }));
show("accessor deep answer differs", equal(deepAnswer, { o: { n: [1, 3] } }));

const holdsItself: any = {};
Object.defineProperty(holdsItself, "self", {
  enumerable: true,
  get() {
    return holdsItself;
  },
});
const holdsItselfTwin: any = {};
Object.defineProperty(holdsItselfTwin, "self", {
  enumerable: true,
  get() {
    return holdsItselfTwin;
  },
});
show("cyclic accessor", equal(holdsItself, holdsItselfTwin));

let symbolRuns = 0;
const key = Symbol("key");
const symbolAccessor = (value: string): any => {
  const object: any = {};
  Object.defineProperty(object, key, {
    enumerable: true,
    get() {
      symbolRuns += 1;
      return value;
    },
  });
  return object;
};
show("symbol accessor", equal(symbolAccessor("same"), symbolAccessor("same")));
show("symbol getter runs", symbolRuns);
show("symbol accessor differs", equal(symbolAccessor("same"), symbolAccessor("other")));

const hiddenSymbol: any = {};
Object.defineProperty(hiddenSymbol, Symbol("hidden"), {
  enumerable: false,
  get() {
    return 1;
  },
});
show("non-enumerable symbol accessor", equal(hiddenSymbol, {}));
show("symbol accessor vs data", equal(symbolAccessor("v"), { [key]: "v" }));

// A class instance and a Date subclass instance carry their accessors the
// same way; the getter still runs with the instance as `this`.
class Container {
  hint: string;
  constructor(hint: string) {
    this.hint = hint;
  }
}
const container = (): any => {
  const value: any = new Container("same");
  Object.defineProperty(value, "extra", {
    enumerable: true,
    get() {
      return this.hint;
    },
  });
  return value;
};
show("class instance accessor", equal(container(), container()));
show("class instance accessor differs", equal(container(), { hint: "same", extra: "same" }));

class Dated extends Date {
  hint = "same";
  constructor(time: number) {
    super(time);
  }
}
const dated = (): any => {
  const value: any = new Dated(1_000);
  Object.defineProperty(value, "extra", {
    enumerable: true,
    get() {
      return this.hint;
    },
  });
  return value;
};
show("date subclass accessor", equal(dated(), dated()));
const datedOther = dated();
datedOther.hint = "other";
show("date subclass accessor differs", equal(dated(), datedOther));

// A getter that throws while a collection member is compared reaches the
// caller.
const throwingValue: any = {};
Object.defineProperty(throwingValue, "x", {
  enumerable: true,
  get() {
    throw new RangeError("member");
  },
});
attempt("map member getter throws", () => equal(new Map([["k", throwingValue]]), new Map([["k", { x: 1 }]])));
attempt("set member getter throws", () => equal(new Set([throwingValue]), new Set([{ x: 1 }])));

// The first object's getter runs before the matching property of the second
// object is read, so a side effect it makes on the second object is what
// that read answers.
const mutatesValue: any = { x: 1 };
const valueWriter: any = {};
Object.defineProperty(valueWriter, "x", {
  enumerable: true,
  get() {
    mutatesValue.x = 5;
    return 1;
  },
});
show("getter mutates other value", equal(valueWriter, mutatesValue));
show("mutation persisted", mutatesValue.x);

const grows: any = { x: 1 };
const grower: any = {};
Object.defineProperty(grower, "x", {
  enumerable: true,
  get() {
    grows.extra = 2;
    return 1;
  },
});
show("getter adds other key", equal(grower, grows));

const shrinks: any = { x: 1, y: 2 };
const shrinker: any = {
  get x() {
    delete shrinks.y;
    return 1;
  },
  y: 2,
};
show("getter deletes other key", equal(shrinker, shrinks));

// The second object's getter runs after the first object's value is read.
const readFirst: any = { x: 1, y: 2 };
const lateWriter: any = {
  get x() {
    readFirst.y = 9;
    return 1;
  },
  y: 2,
};
show("second getter runs after first read", equal(readFirst, lateWriter));

console.log("done");
