// Static fields written and reflected on through class values held as
// untyped values, across a class family whose subclasses inherit the base's
// static fields: the helpers that route these writes test every class the
// value can hold.
class Shape {
  static sides = 0;
  static label = "shape";
  static scale = 1;
  describe(): string {
    return "shape";
  }
}
class Triangle extends Shape {
  static corners = 3;
}
class Square extends Shape {
  static corners = 4;
}
class Pentagon extends Shape {
  static corners = 5;
}
class Hexagon extends Shape {
  static corners = 6;
}
class Cube extends Square {
  static faces = 6;
}

function untyped(value: unknown): unknown {
  return value;
}

const family: (typeof Shape)[] = [Shape, Triangle, Square, Pentagon, Hexagon, Cube];
const held = family.map((cls) => untyped(cls) as Record<string, unknown>);

// Writes of each class's own static fields through a computed key.
const own: Record<string, string[]> = {
  Shape: ["sides", "label", "scale"],
  Triangle: ["corners"],
  Square: ["corners"],
  Pentagon: ["corners"],
  Hexagon: ["corners"],
  Cube: ["faces"],
};
held.forEach((cls, index) => {
  const name = family[index]!.name;
  for (const key of own[name]!) {
    const before = cls[key];
    cls[key] = typeof before === "number" ? before + 10 : `${String(before)}!`;
    console.log(name, key, String(before), "->", String(cls[key]));
  }
  console.log(name, "Reflect.set", Reflect.set(cls as object, own[name]![0]!, cls[own[name]![0]!]));
});

// Keys that are no static field go to the class's property table.
held.forEach((cls, index) => {
  const name = family[index]!.name;
  cls["extra"] = index;
  Object.assign(cls, { added: name });
  Object.defineProperty(cls, "defined", { value: index * 2, enumerable: true });
  console.log(name, String(cls["extra"]), String(cls["added"]), String(cls["defined"]));
  console.log(name, "delete", Reflect.deleteProperty(cls as object, "extra"), String(cls["extra"]));
});

console.log(Shape.sides, Shape.label, Shape.scale);
console.log(Triangle.corners, Square.corners, Pentagon.corners, Hexagon.corners, Cube.faces);
console.log(Cube.corners, Cube.sides, Triangle.sides);
