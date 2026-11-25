// The JavaScript form, with JSDoc types: an async loader that returns its
// row early when there is nothing to add, mapped over rows and gathered
// with Promise.all into the same binding. A loop over the result resets a
// computed key to null and fills it from a lookup. Promise.all fulfills
// with each entry's settled value, so the loop binding is a row.

/** @typedef {Record<string, unknown> & { id?: string | number }} Row */

/**
 * @param {Row} row
 * @param {string[]} extras
 * @returns {Promise<Row>}
 */
async function enrich(row, extras) {
  if (extras.length === 0) return row;
  /** @type {Row} */
  const copy = { ...row };
  for (const extra of extras) copy[extra] = await Promise.resolve(`${extra}-${String(row.id)}`);
  return copy;
}

/** @type {Record<string, string>} */
const owners = { a: "ann", c: "cy" };

/**
 * @param {Row[]} rows
 * @param {string[]} keys
 * @returns {string}
 */
function render(rows, keys) {
  return rows.map((row) => keys.map((key) => `${key}=${String(row[key])}`).join(",")).join(" ");
}

/**
 * @param {Row[]} input
 * @param {string[]} extras
 * @param {string} link
 * @returns {Promise<Row[]>}
 */
async function gather(input, extras, link) {
  /** @type {Row[]} */
  let rows = input.map((row) => ({ ...row }));
  rows = await Promise.all(rows.map((row) => enrich(row, extras)));
  for (const row of rows) {
    const id = row.id;
    row[link] = null;
    if (typeof id === "string" && owners[id] !== undefined) row[link] = owners[id];
  }
  return rows;
}

async function main() {
  /** @type {Row[]} */
  const base = [{ id: "a" }, { id: 2 }, { id: "c", note: "n" }];
  const link = process.argv.length > 0 ? "owner" : "other";
  const added = await gather(base, ["x"], link);
  console.log(render(added, ["id", "x", "owner", "note"]));
  const plain = await gather(base, [], link);
  console.log(render(plain, ["id", "x", "owner"]));
  console.log(render(base, ["id", "owner"]));
}

await main();
