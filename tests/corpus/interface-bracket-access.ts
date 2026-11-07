// Members of an interface read by bracket with a literal key.
interface Shape { scale: number; area(): number }
class Sq implements Shape { scale = 1; area(): number { return 4; } }
class Ci implements Shape { scale = 2; area(): number { return 3; } }
function read(shape: Shape): number { return shape["scale"] * shape["area"](); }
console.log(read(new Sq()), read(new Ci()));
