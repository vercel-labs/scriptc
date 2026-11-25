// The project's own ambient declarations: the tsconfig includes this file,
// and no module imports it.
interface Measure {
  unit: Unit;
  amount: number;
}
type Unit = "m" | "s";
