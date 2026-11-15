// An array literal of object literals with no annotation: the checker's
// element type is a union of the literals' types, each completed with the
// members only its siblings have. A literal that differs from its siblings
// only inside a nested record fits several of those arms at its own level;
// the arm that keeps every member at every depth is its layout.

const base = () => ({
  label: { kind: "text", least: 1, most: 40 },
  weight: { kind: "number", low: 0 },
  tags: {
    anyOf: [
      { kind: "text", least: 1 },
      { kind: "list", each: { kind: "text", least: 1 } },
    ],
  },
});

const routed = {
  lane: { kind: "text", least: 1, most: 8 },
};

const stops = { kind: "list", each: { kind: "text", least: 1, most: 16 }, atLeast: 1 };

const parcelRules = () => ({
  anyOf: [
    {
      kind: "record",
      closed: true,
      fields: { ...base(), ...routed, mode: { oneOf: ["road"] } },
    },
    {
      kind: "record",
      closed: true,
      needs: ["mode", "when"],
      fields: { ...base(), mode: { is: "air" }, when: { is: "daily" } },
    },
    {
      kind: "record",
      closed: true,
      needs: ["mode", "stops"],
      fields: {
        ...base(),
        mode: { is: "air" },
        when: { is: "charter" },
        stops,
        carrier: { kind: "text", least: 1 },
      },
    },
    {
      kind: "record",
      closed: true,
      needs: ["mode"],
      fields: { ...base(), mode: { is: "rail" }, stops },
    },
  ],
});

const rules = parcelRules();
console.log(rules.anyOf.length);
console.log(JSON.stringify(rules));
for (const rule of rules.anyOf) {
  console.log(rule.kind, rule.closed, Object.keys(rule).join(","), Object.keys(rule.fields).join(","));
}

// Three levels down, and inside an element.
const nested = [
  { name: "a", outer: { inner: { x: 1 } } },
  { name: "b", outer: { inner: { x: 1, y: 2 } } },
  { name: "c", outer: { inner: { x: 1, y: 2, z: 3 } } },
];
for (const item of nested) console.log(item.name, JSON.stringify(item.outer));

const lists = [
  { name: "one", rows: [{ id: 1 }] },
  { name: "two", rows: [{ id: 2, note: "n" }] },
  { name: "three", rows: [{ id: 3, note: "m", done: true }] },
];
console.log(JSON.stringify(lists));
console.log(lists.map((entry) => `${entry.name}:${entry.rows.length}:${Object.keys(entry.rows[0]!).join("+")}`).join(" "));
