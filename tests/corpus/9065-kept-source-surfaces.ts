// Records that keep the keys their type does not declare: each value below was
// an untyped object first, and every reflective surface answers for the whole
// object, as Node does. The same surfaces over records that were never untyped
// (Plain) answer from the declared fields beside them.
type Item = { id: number; name: string };
type Plain = { id: number; name: string; tag?: string };

const parsed = JSON.parse('{"name":"n","extra":5,"id":7,"more":"z"}') as Item;
const loose: any = { zeta: 1, id: 8, name: "m" };
const assigned: Item = loose;
const plain: Plain = { id: 1, name: "p" };
const tagged: Plain = { name: "t", tag: "T", id: 2 };

function surfaces(label: string, v: Item): void {
  const seen: string[] = [];
  for (const key in v) seen.push(key);
  console.log(label, "keys", Object.keys(v).join(","));
  console.log(label, "values", Object.values(v).length);
  console.log(label, "entries", Object.entries(v).map(([key]) => key).join(","));
  console.log(label, "for-in", seen.join(","));
  console.log(label, "json", JSON.stringify(v));
  console.log(label, "names", Object.getOwnPropertyNames(v).join(","));
  console.log(label, "in", "extra" in v, "zeta" in v, "id" in v, "none" in v);
  console.log(label, "hasOwn", Object.hasOwn(v, "extra"), Object.hasOwn(v, "zeta"), Object.hasOwn(v, "name"));
  console.log(label, "own", Object.prototype.hasOwnProperty.call(v, "extra"), v.hasOwnProperty("zeta"));
  console.log(label, "spread", JSON.stringify({ ...v }));
  console.log(label, "inspect", v);
}

surfaces("parsed", parsed);
surfaces("assigned", assigned);
surfaces("plain", plain);
surfaces("tagged", tagged);

function plainSurfaces(v: Plain): string {
  const seen: string[] = [];
  for (const key in v) seen.push(key);
  return [Object.keys(v).join(","), seen.join(","), JSON.stringify(v), "tag" in v, Object.hasOwn(v, "tag")].join(" | ");
}
console.log(plainSurfaces(plain));
console.log(plainSurfaces(tagged));

// A list of converted values and a nested one.
type Page = { items: Item[]; first: Item };
const page = JSON.parse('{"first":{"id":1,"name":"a","k":1},"items":[{"name":"b","id":2,"q":"r"}],"total":1}') as Page;
console.log(Object.keys(page).join(","), Object.keys(page.first).join(","), Object.keys(page.items[0]!).join(","));
console.log(JSON.stringify(page));
