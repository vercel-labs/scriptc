import snapshot from "../../docs/src/generated/node-v24-compatibility.json";

export { snapshot };
const chapters = new Map(snapshot.chapters.map((chapter) => [chapter.slug, chapter.title]));
export const label = (row: typeof snapshot.rows[number]) => row.depth === 0 ? chapters.get(row.chapter) ?? row.label : row.label;

// Select matches and their ancestor chain directly from the published preorder
// census, independently of the UI's tree/filter implementation.
export function expectedLabels(query: string, staticStatus = "all", dynamicStatus = "all") {
  const included = new Set<string>();
  const ancestors: typeof snapshot.rows = [];
  for (const row of snapshot.rows) {
    ancestors.length = row.depth;
    ancestors[row.depth] = row;
    if (staticStatus !== "all" && row.static.status !== staticStatus) continue;
    if (dynamicStatus !== "all" && row.dynamic.status !== dynamicStatus) continue;
    const text = [chapters.get(row.chapter), row.kind, row.name, row.signature, row.apiSymbol, row.static.detail, row.dynamic.detail].join(" ").toLocaleLowerCase();
    if (!text.includes(query.toLocaleLowerCase())) continue;
    for (const ancestor of ancestors) if (ancestor) included.add(ancestor.id);
  }
  return snapshot.rows.filter((row) => included.has(row.id)).map(label);
}
