// A FinalizationRegistry accepts any object as a target. ECMAScript lets an
// implementation never collect a target and never call its cleanup, so a
// target whose reference kind has no weak lifetime lowering still registers;
// only the unregister token's count is read back, and primitives are the
// TypeError Node raises.

class Geometry {
  constructor() {
    this.vertices = [1, 2, 3];
  }
}

const registry = new FinalizationRegistry(() => {});

const geometry = new Geometry();
const token = {};

registry.register(geometry, "geometry");
registry.register({ id: 1 }, "literal", token);
registry.register([1, 2, 3], "array");

console.log("registered", typeof registry, registry.unregister(token), registry.unregister({}));
console.log("token again", registry.unregister(token));

try {
  registry.register(1, "number");
} catch (error) {
  console.log("primitive", error.name);
}

try {
  registry.register(null, "null");
} catch (error) {
  console.log("null", error.name);
}

registry.register(new Geometry(), "second geometry");
console.log("done");
