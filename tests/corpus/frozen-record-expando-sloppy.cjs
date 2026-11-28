// The same frozen record in sloppy code: Node's writes, additions and
// deletes are silently ignored, so the record keeps its own properties.
// Differentially vs Node.
const early = { id: 1, label: "early" };
early["tag"] = "e";
Object.freeze(early);
function attempt(label, write) {
  try {
    write();
    console.log(`${label}: ok`);
  } catch (error) {
    console.log(`${label}: ${error.name}`);
  }
}
console.log("frozen:", Object.keys(early).join(","), String(early["tag"]));
attempt("write", () => { early["tag"] = "changed"; });
attempt("add", () => { early["later"] = 1; });
attempt("delete", () => { delete early["tag"]; });
console.log(Object.keys(early).join(","), JSON.stringify(early));
