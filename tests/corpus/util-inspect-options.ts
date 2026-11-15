// util.inspect's three tables: defaultOptions (the options a call does not
// give), colors (the SGR pairs) and styles (the styleType → color map) —
// Node's members are writable, and every inspect/format/console rendering
// reads them per call. The program also exercises the rendering surfaces
// that must route through the runtime once the tables can change.
import { format, formatWithOptions, inspect } from "node:util";

const deep = { a: { b: { c: 1 } }, z: [1, 2, 3] };
const show = (label: string, run: () => unknown): void => {
  try {
    console.log(label, JSON.stringify(run()));
  } catch (e: any) {
    console.log(label, e.name, e.message);
  }
};

console.log("keys", Object.keys(inspect.defaultOptions).join(","));
console.log("values", JSON.stringify(inspect.defaultOptions));
console.log("identity", inspect.defaultOptions === inspect.defaultOptions);
console.log(
  "sealed",
  Object.isExtensible(inspect.defaultOptions),
  Object.isSealed(inspect.defaultOptions),
  Object.isFrozen(inspect.defaultOptions),
);
console.log("descriptor", JSON.stringify(Object.getOwnPropertyDescriptor(inspect.defaultOptions, "depth")));
console.log("baseline", inspect(deep));
console.log("baseline format", format(deep), format("%O", deep), format("%o", deep));
console.log("baseline console", JSON.stringify(deep));

// depth: every surface reads the default a call does not give.
inspect.defaultOptions.depth = 1;
console.log("depth1 inspect", inspect(deep));
console.log("depth1 format", format(deep));
console.log("depth1 %O", format("%O", deep));
console.log("depth1 %o", format("%o", deep));
console.log("depth1 fwo", formatWithOptions({}, "%O", deep));
console.log("depth1 console", JSON.stringify(deep));
console.dir(deep);
// The call's own options still win over the defaults.
console.log("explicit", inspect(deep, { depth: 2 }));
console.log("explicit null", inspect(deep, { depth: null }));
console.log("explicit fwo", formatWithOptions({ depth: 2 }, "%O", deep));

// The setter merges its object over the defaults, skipping undefined.
inspect.defaultOptions = { depth: 0, sorted: true, colors: undefined };
console.log("merged", JSON.stringify(inspect.defaultOptions));
console.log("sorted", inspect({ b: 1, a: { c: 2 } }));
console.log("sorted format", format({ b: 1, a: { c: 2 } }));
show("null", () => {
  inspect.defaultOptions = null as any;
  return "no";
});
show("array", () => {
  inspect.defaultOptions = [] as any;
  return "no";
});
show("number", () => {
  inspect.defaultOptions = 42 as any;
  return "no";
});
show("unknown key", () => {
  inspect.defaultOptions = { nope: true } as any;
  return "no";
});
inspect.defaultOptions = {
  depth: 2,
  sorted: false,
  colors: false,
  maxArrayLength: 2,
  maxStringLength: 4,
  breakLength: 10,
  compact: false,
  showHidden: false,
};
console.log("maxArrayLength", inspect([1, 2, 3, 4, 5]));
console.log("maxStringLength", inspect("abcdefgh"));
console.log("breakLength", inspect({ first: 1, second: 2, third: 3 }));
console.log("compact false", inspect([[1, 2], [3, 4]]));

// styles maps a styleType to a color name; colors names the SGR pair.
console.log(
  "colors shape",
  Object.keys(inspect.colors).length,
  Object.getOwnPropertyNames(inspect.colors).length,
  Object.getPrototypeOf(inspect.colors) === null,
);
console.log("colors red", JSON.stringify(inspect.colors.red), JSON.stringify(inspect.colors.grey));
console.log("styles keys", Object.keys(inspect.styles).join(","));
console.log("styles proto", Object.getPrototypeOf(inspect.styles) === null);
inspect.colors.yellow = [101, 102];
console.log("mutated", JSON.stringify(inspect(1, { colors: true })));
console.log(
  "mutated leaves",
  JSON.stringify(inspect(["s", 1, true, null, undefined, 1n], { colors: true })),
);
inspect.colors = { red: [31, 39] };
console.log("replaced", JSON.stringify(inspect(1, { colors: true })), JSON.stringify(inspect("x", { colors: true })));
inspect.colors = { number: [31, 39] };
console.log("array key", JSON.stringify(inspect(1, { colors: true })));
inspect.styles.number = "red";
inspect.colors = { red: [96, 39] };
console.log("custom style", JSON.stringify(inspect(1, { colors: true })));
inspect.styles = { number: "missing" };
console.log("missing style", JSON.stringify(inspect(1, { colors: true })));
show("null colors", () => {
  inspect.styles = { number: "red" };
  inspect.colors = null as any;
  return inspect(1, { colors: true });
});
inspect.styles = { number: "yellow" };
inspect.colors = { yellow: [33, 39] };
console.log("restored", JSON.stringify(inspect(1, { colors: true })));

// colors: true as a default colors every surface that inspects.
inspect.defaultOptions = { colors: true };
console.log("default colors", JSON.stringify(inspect(1)), JSON.stringify(format("%O", { a: 1 })));
console.dir({ a: 1 });

// console.dir reads the defaults around its own options, with custom
// inspection off.
inspect.defaultOptions = { depth: 0 };
console.dir(deep, { depth: 2 });
console.dir(deep, { customInspect: false });
console.dir(deep, null as any);
console.dir(deep, "not options" as any);

// inspect.custom is Symbol.for's key, as it is in Node.
console.log(
  "custom",
  typeof inspect.custom,
  inspect.custom === Symbol.for("nodejs.util.inspect.custom"),
);
console.log("custom descriptor", JSON.stringify(Object.getOwnPropertyDescriptor(inspect, "custom")!));
