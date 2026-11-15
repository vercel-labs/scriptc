const NAMES: string[] = ["triangle", "square", "pentagon"];
console.log("broken starts with", NAMES.length, "names");
function pick(index: number): string {
  const name = NAMES[index];
  if (name === undefined) throw new RangeError("no shape " + index);
  return name;
}
// Throws while the module loads: the importer sees it at the import.
export const MISSING: string = pick(7);
console.log("broken finished");
