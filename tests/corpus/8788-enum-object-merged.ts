// Constant initializers that refer to earlier members, an enum merged
// across two declarations (one object, filled in declaration order), enums
// inside a namespace, and const enums beside them (inlined, no object).
const enum Unit {
  One = 1,
}
enum Flags {
  None = 0,
  Read = 1 << 0,
  Write = Read << 1,
  Both = Read | Write,
  Mask = ~Both,
  Next = Both + Unit.One,
  Label = "flags",
  Tagged = `${Label}-tagged`,
  Joined = Label + "!",
  Scaled = (Read + Write) * 2 ** 3,
  After,
}
console.log(JSON.stringify(Object.entries(Flags)));
console.log(Flags[Flags.Both], Flags[Flags.Mask], Flags[25], Flags.Tagged, Flags.Joined);

enum Merged {
  A = 1,
  B,
}
enum Merged {
  C = 10,
  D = A + C,
  E = Merged.B * 3,
}
console.log(JSON.stringify(Object.entries(Merged)), Object.keys(Merged).length);
const held = Merged;
console.log(held === Merged, held.D, Merged[11], Merged[6]);

namespace Shapes {
  export enum Kind {
    Circle,
    Square = "square",
  }
  enum Hidden {
    X,
    Y,
  }
  export const hiddenNames = Object.keys(Hidden).join(",");
  export function kinds(): string[] {
    return Object.keys(Kind);
  }
}
console.log(JSON.stringify(Object.entries(Shapes.Kind)), Shapes.hiddenNames, Shapes.kinds().join(","));
console.log(Shapes.Kind[0], Shapes.Kind.Square, Object.values(Shapes.Kind).includes("square"));
const position: number = process.argv.length > 99 ? 1 : 0;
console.log(Shapes.Kind[position], Shapes.Kind[position + 1]);
console.log(Unit.One, Unit["One"]);
