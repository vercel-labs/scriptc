// Records JavaScript builds in its own key order, handed to TypeScript
// through typed slots: a draft from a "validator", a stored row, and a
// replacement method installed through a computed key.
export function validate(input) {
  return { year: input.year, title: input.title, tags: input.tags };
}

export function storeRow(rows, id) {
  rows.set(id, { title: "Stored", id, tags: [], year: 1999, createdAt: "t0", version: 1 });
}

export function replace(target, name) {
  target[name] = (id) => ({ version: 7, id, year: 2001, title: "Replaced", tags: ["r"], createdAt: "t1" });
}
