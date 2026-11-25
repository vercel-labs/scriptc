// A `types` entry that is a declaration file of its own in a `typeRoots`
// directory: `types: ["measures"]` names typings/measures.d.ts.
type Unit = "m" | "s";
interface Measure {
  unit: Unit;
  amount: number;
}
