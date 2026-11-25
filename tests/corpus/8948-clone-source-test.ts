// Same-shape clones `{ ...r, k: v }` of a type the program also converts
// from JSON: a clone of a record that kept undeclared keys or another key
// order shows them, a clone of a record the program built shows its fields
// in their order, and a clone that creates an optional key lists it last.
type Item = { id: number; label: string; note?: string; tags?: string[] };

function keys(item: Item): string {
  return Object.keys(item).join(",");
}
function show(label: string, item: Item): void {
  const walked: string[] = [];
  for (const k in item) walked.push(k);
  console.log(label, JSON.stringify(item), keys(item), walked.join(","), Object.entries(item).length);
}

function relabel(item: Item, label: string): Item {
  return { ...item, label };
}
function renumber(item: Item): Item {
  return { ...item, id: item.id + 1, label: item.label.toUpperCase() };
}
function annotate(item: Item, note: string): Item {
  return { ...item, note };
}
function retag(item: Item): Item {
  return { ...item, tags: [...(item.tags ?? []), "t"], id: 0 };
}

// Built by the program: declared keys, declaration order.
const built: Item = { id: 1, label: "one" };
show("built", built);
show("built relabel", relabel(built, "uno"));
show("built renumber", renumber(built));
show("built annotate", annotate(built, "n"));
show("built retag", retag(built));
show("built annotate retag", retag(annotate(built, "n")));
show("built retag annotate", annotate(retag(built), "n"));

// With the optional key already there, a clone replaces it in place.
const noted: Item = { id: 2, label: "two", note: "old" };
show("noted annotate", annotate(noted, "new"));
show("noted relabel", relabel(noted, "dos"));

// Parsed in declaration order with nothing undeclared: like a built record.
const plain = JSON.parse('{"id":3,"label":"three"}') as Item;
show("plain relabel", relabel(plain, "tres"));
show("plain annotate", annotate(plain, "n"));

// Parsed in another order.
const reordered = JSON.parse('{"label":"four","id":4}') as Item;
show("reordered", reordered);
show("reordered relabel", relabel(reordered, "cuatro"));
show("reordered renumber", renumber(reordered));
show("reordered annotate", annotate(reordered, "n"));
show("reordered twice", relabel(relabel(reordered, "x"), "y"));

// Parsed with keys the type does not declare.
const extra = JSON.parse('{"id":5,"owner":"me","label":"five","tags":["a"],"rank":9}') as Item;
show("extra", extra);
show("extra relabel", relabel(extra, "cinco"));
show("extra renumber", renumber(extra));
show("extra annotate", annotate(extra, "n"));
show("extra retag", retag(extra));
show("extra chain", annotate(retag(relabel(extra, "v")), "w"));
console.log("owner" in relabel(extra, "v"), Object.hasOwn(renumber(extra), "rank"), "owner" in relabel(built, "v"));

// An override whose value changes the source: the copy holds the keys the
// source had when the spread read it.
const moving = JSON.parse('{"id":6,"label":"six","note":"gone"}') as Item;
const copied: Item = { ...moving, label: (delete moving.note, "after") };
show("moving", moving);
show("copied", copied);

// Many clones in a loop, of built and parsed records alike.
let total = 0;
let current = built;
let other = extra;
for (let i = 0; i < 500; i++) {
  current = renumber(current);
  other = relabel(other, `l${i % 7}`);
  total += current.id + other.label.length + Object.keys(other).length;
}
console.log(total, keys(current), keys(other));
