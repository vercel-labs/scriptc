// A frozen record refuses expando writes, changes and deletes in strict
// code: Node throws TypeError and leaves the record unchanged. The expando
// properties written before the freeze are kept and still enumerate.
// Differentially vs Node.
type Item = { id: number; label: string };

function attach(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

function attempt(label: string, write: () => void): void {
  try {
    write();
    console.log(`${label}: ok`);
  } catch (error) {
    console.log(`${label}: ${(error as Error).name}`);
  }
}

const early: Item = { id: 1, label: "early" };
attach(early, "tag", "e");
Object.freeze(early);
console.log("frozen:", Object.keys(early).join(","), String((early as Record<string, unknown>)["tag"]));
attempt("write", () => attach(early, "tag", "changed"));
attempt("add", () => attach(early, "later", 1));
attempt("delete", () => {
  delete (early as Record<string, unknown>)["tag"];
});
console.log(Object.keys(early).join(","), JSON.stringify(early));
