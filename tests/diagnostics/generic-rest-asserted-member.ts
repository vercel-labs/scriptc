// A rest binding inside a generic function whose source is asserted to an
// intersection, where the pattern leaves the intersection's extra member in
// the rest. The rest would then hold the bound type's own fields and that
// member, and the bound type's layout has no slot for it, so the copy is
// refused rather than built without one of them.
interface Shape {
  hidden?: boolean;
  sides: number;
}

interface Tile extends Shape {
  colour: string;
}

function unsided<T extends Shape>(shape: T): number {
  const { sides, ...others } = shape as T & { glaze?: string };
  console.log(others);
  return sides;
}

const tile: Tile = { sides: 4, colour: "teal" };
console.log(unsided(tile));
