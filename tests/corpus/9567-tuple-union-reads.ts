// A value whose type is a union of tuple types is read by position, asked
// for its length and destructured. Each arm answers from its own layout; a
// position an arm does not have reads undefined. The value is held as a
// parameter, as a table entry narrowed past undefined, as an optional
// parameter and as a nullable field narrowed past null: the stored binding
// then still has the undefined or null arm.
type Edge = [from: number, label: string] | [from: string, label: string];
type Mark = [at: number] | [at: number, note: string];
type Row = [number, string] | string[];

function direct(edge: Edge): void {
  const [from, label] = edge;
  console.log("direct", edge[0], edge[1], edge.length, typeof edge[0], from, label);
}
direct([1, "one"]);
direct(["x", "two"]);

const edges: Record<string, Edge> = { a: [1, "one"], b: ["x", "two"] };
function fromTable(key: string): void {
  const hit = edges[key];
  if (hit === undefined) {
    console.log("table", key, "none");
    return;
  }
  const [from, label = "unlabelled"] = hit;
  console.log("table", key, hit[0], hit[1], hit.length, from, label, JSON.stringify(hit));
}
fromTable("a");
fromTable("b");
fromTable("c");

function optional(mark?: Mark): void {
  if (mark === undefined) {
    console.log("optional none");
    return;
  }
  const [at, note] = mark;
  console.log("optional", mark[0], mark.length, at, note, note === undefined);
}
optional([1]);
optional([2, "two"]);
optional();

function nullable(box: { row: Row | null }): void {
  const row = box.row;
  if (row === null) {
    console.log("nullable null");
    return;
  }
  const [first, second] = row;
  console.log("nullable", row[0], row[1], row.length, first, second, Array.isArray(row));
}
nullable({ row: [1, "one"] });
nullable({ row: ["p", "q", "r"] });
nullable({ row: null });

// Records inside the tuples keep their identity through a position read.
type Tagged = [{ id: number }, string] | [{ name: string }, string];
function tagged(value: Tagged | undefined): string {
  if (value === undefined) return "nothing";
  const head = value[0];
  return `${JSON.stringify(head)} ${value[1]} ${head === value[0]}`;
}
console.log(tagged([{ id: 7 }, "seven"]), tagged([{ name: "n" }, "named"]), tagged(undefined));
