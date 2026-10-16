// The JavaScript form of 4946, shaped like a model layer's batch loader: an
// async loader that returns its record early when there is nothing to
// include, mapped over records and gathered with Promise.all into the same
// binding. The loop over that result then reads and writes computed keys on
// each record (a polymorphic relation reset to null and filled in from a
// lookup). Promise.all fulfills with each entry's settled value, so the loop
// binding is a record. The loader's early return, with an empty include
// list, runs through the same map and Promise.all.

/** @typedef {Record<string, unknown> & { id?: string | number }} Row */

/**
 * @param {Row} record
 * @param {string[]} includes
 * @returns {Promise<Row>}
 */
async function loadRelationships(record, includes) {
  if (!includes || includes.length === 0 || !record) return record;
  /** @type {Row} */
  const enriched = Object.fromEntries(Object.entries(record));
  for (const relationName of includes)
    enriched[relationName] = await Promise.resolve(`${relationName}:${String(record.id)}`);
  return enriched;
}

/** @type {Record<string, Row[]>} */
const tables = {
  post: [{ id: "p1", title: "first" }, { id: "p2", title: "second" }],
  photo: [{ id: "f1", title: "sunset" }],
};

/**
 * @param {Row[]} records
 * @param {string[]} includes
 * @param {string[]} polymorphic
 * @returns {Promise<Row[]>}
 */
async function loadMany(records, includes, polymorphic) {
  /** @type {Row[]} */
  let enriched = records.map((r) => ({ ...r }));
  if (includes.length > 0)
    enriched = await Promise.all(enriched.map((record) => loadRelationships(record, includes)));

  for (const relationName of polymorphic) {
    const typeFieldName = `${relationName}Type`;
    /** @type {Record<string, Map<string, Row[]>>} */
    const byType = {};
    for (const record of enriched) {
      const contentType = /** @type {string | undefined} */ (record[typeFieldName]);
      const contentId = record[relationName];
      record[relationName] = null;
      if (!contentType || typeof contentId !== "string" || !tables[contentType]) continue;
      let holders = byType[contentType];
      if (!holders) {
        holders = new Map();
        byType[contentType] = holders;
      }
      holders.set(contentId, [...(holders.get(contentId) ?? []), record]);
    }
    await Promise.all(
      Object.entries(byType).map(async ([type, holders]) => {
        const related = await Promise.resolve(tables[type] ?? []);
        for (const row of related)
          for (const record of holders.get(String(row.id)) ?? []) record[relationName] = row;
      }),
    );
  }
  return enriched;
}

/** @param {Row[]} rows @param {string[]} keys */
function show(rows, keys) {
  return rows
    .map((row) =>
      keys
        .map((key) => {
          const value = row[key];
          return `${key}=${value && typeof value === "object" ? String(/** @type {Row} */ (value).title) : String(value)}`;
        })
        .join(" "),
    )
    .join(" | ");
}

/** @type {Row[]} */
const comments = [
  { id: "c1", target: "p2", targetType: "post" },
  { id: "c2", target: "f1", targetType: "photo" },
  { id: "c3", target: "zz", targetType: "video" },
  { id: "c4", target: "p1", targetType: "post" },
];

/** @type {string[]} */
const includes = [];
if (process.argv.length < 99) includes.push("author");

const loaded = await loadMany(comments, includes, ["target"]);
console.log(show(loaded, ["id", "author", "target"]));
console.log(show(comments, ["id", "target"]));

const plain = await loadMany(comments, [], ["target"]);
console.log(show(plain, ["id", "author", "target"]));

/** @type {string[]} */
const none = [];
if (process.argv.length > 99) none.push("never");
const same = await Promise.all(comments.map((record) => loadRelationships(record, none)));
const key = process.argv.length < 99 ? "seen" : "other";
for (const record of same) record[key] = record[key] ?? String(record.id).toUpperCase();
console.log(show(same, ["id", "author", "target", "seen"]));
