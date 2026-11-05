// A Map or Set handed to a record type that spells one of its members stays
// the collection itself: later writes are visible through the view, and the
// view casts back to the same collection.
type Exists = { has(key: string): boolean };

function freeId(existing: Exists): string {
  for (let i = 0; i < 5; i++) {
    const id = "id" + i;
    if (!existing.has(id)) return id;
  }
  return "none";
}

const byId = new Map<string, number>();
byId.set("id0", 1);
console.log(freeId(byId));
byId.set("id1", 2);
console.log(freeId(byId));

const seen = new Set<string>();
seen.add("id0");
seen.add("id1");
seen.add("id2");
console.log(freeId(seen));

// The view is live: entries added after the conversion are visible.
const view: Exists = byId;
byId.set("id3", 3);
console.log(view.has("id3"), byId.has("id3"));
console.log((view as unknown as Map<string, number>) === byId);
const setView: Exists = seen;
seen.add("id3");
console.log(setView.has("id3"), (setView as unknown as Set<string>) === seen);

// A record literal of the same shape keeps working.
console.log(freeId({ has: (key: string) => key === "id0" }));

// A member Map answers without a stored field.
type Sized = { readonly size: number };
const sized: Sized = byId;
byId.set("id4", 4);
console.log(sized.size, byId.size);

// A view handed on to a second structural type is still the collection: the
// second view's calls answer through it, and later writes stay visible.
type Lookup = { get(key: string): number | undefined };
type Table = { get(key: string): number | undefined; has(key: string): boolean };
function viaLookup(table: Lookup, key: string): number {
  return table.get(key) ?? -1;
}
function viaTable(table: Table, key: string): number {
  return table.has(key) ? viaLookup(table, key) : -2;
}
console.log(viaTable(byId, "id1"), viaTable(byId, "nope"));
byId.set("id5", 5);
console.log(viaTable(byId, "id5"));
type Member = { has(key: string): boolean };
function viaMember(member: Member, key: string): boolean {
  return member.has(key);
}
function viaExists(existing: Exists, key: string): boolean {
  return viaMember(existing, key);
}
console.log(viaExists(seen, "id3"), viaExists(seen, "id9"));
