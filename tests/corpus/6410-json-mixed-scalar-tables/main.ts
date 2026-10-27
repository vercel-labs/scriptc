// JSON tables whose rows mix strings and numbers, the shape of a
// character-set table (`[["8140", 12288, 65292], ...]`) and of a
// code-point range map (`[[[0, 44], "disallowed"], [[65, 65], "mapped",
// [97]], ...]`). A package requires them at load or inside a function, and
// an ES module imports one; each row keeps its strings and numbers.
import { lookup, rowCount } from "code-table";
import { mapChars, status } from "range-map";
import extra from "./extra.json" with { type: "json" };

console.log(lookup("8150"), lookup("a1"), lookup("zzzz"), rowCount());
const mapped = mapChars("AB-c9");
console.log(mapped.text, mapped.error);
console.log(JSON.stringify(mapChars("a,b")), JSON.stringify(mapChars("{")));
console.log(status(10), status(46), status(66), status(1000));

for (const row of extra) {
  const head = row[0];
  const rest = row.slice(1);
  console.log(
    typeof head,
    head,
    rest.length,
    rest.map((v) => (v === null ? "null" : typeof v === "number" ? v + 1 : v.toUpperCase())).join(","),
  );
}
console.log(JSON.stringify(extra));
