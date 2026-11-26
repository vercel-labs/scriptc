/* The on-disk encoding of the internal compatibility ledger.
 *
 * The ledger is the largest generated file in the repository, and the
 * push tooling base64-encodes a file into its request, so its serialized
 * size is what limits publishing. The encoder below keeps the same
 * information in about a third of the space:
 *
 *   - every row is an array whose columns are named once in `rowColumns`;
 *   - `static` is [status, evidence, testIndexes | null];
 *   - node stability notes, of which there are a few distinct values, live
 *     once in `stabilities` and each row holds an index;
 *   - test paths live once in `testPaths` and each row holds indexes.
 *
 * `decodeLedger` restores the object shape every reader uses, so consumers
 * only change how they load the file. Keys keep the order the generator
 * builds them, both at the top level and within each row, and each file
 * ends with one newline. A ledger in the older object-row form still
 * decodes (a merge may hand `--local` one), and the next write encodes it.
 */

/** The row's fields in the order the generator builds them. */
export const LEDGER_COLUMNS = [
  "id",
  "chapter",
  "kind",
  "name",
  "signature",
  "label",
  "apiSymbol",
  "depth",
  "scope",
  "anchor",
  "nodeStability",
  "static",
  "anchorSource",
];

const STATIC_COLUMNS = ["status", "evidence", "tests"];

/** Encodes a built snapshot for the file. Throws when a row holds a field
 * this format does not name: a new row field has to be added to
 * LEDGER_COLUMNS (and the reader below) rather than silently dropped. */
export function encodeLedger(snapshot) {
  const stabilities = [];
  const stabilityIndex = new Map();
  const testPaths = [];
  const testIndex = new Map();
  const rows = [];
  for (const row of snapshot.rows) {
    const fields = Object.keys(row);
    if (
      fields.length !== LEDGER_COLUMNS.length ||
      !fields.every((field, i) => field === LEDGER_COLUMNS[i])
    ) {
      throw new Error(
        `ledger row ${row.id} has fields [${fields.join(", ")}]; update LEDGER_COLUMNS in ledger-format.mjs`,
      );
    }
    const staticFields = Object.keys(row.static);
    if (
      row.static.status === undefined ||
      row.static.evidence === undefined ||
      staticFields.length < 2 ||
      staticFields.length > STATIC_COLUMNS.length ||
      !staticFields.every((field, i) => field === STATIC_COLUMNS[i])
    ) {
      throw new Error(
        `ledger row ${row.id} has static fields [${staticFields.join(", ")}]; the format carries status, evidence and tests`,
      );
    }
    let stability = null;
    if (row.nodeStability != null) {
      const key = JSON.stringify(row.nodeStability);
      let at = stabilityIndex.get(key);
      if (at === undefined) {
        at = stabilities.length;
        stabilityIndex.set(key, at);
        stabilities.push(row.nodeStability);
      }
      stability = at;
    }
    let tests = null;
    if (row.static.tests !== undefined) {
      tests = row.static.tests.map((path) => {
        let at = testIndex.get(path);
        if (at === undefined) {
          at = testPaths.length;
          testIndex.set(path, at);
          testPaths.push(path);
        }
        return at;
      });
    }
    rows.push(
      LEDGER_COLUMNS.map((column) => {
        if (column === "static") return [row.static.status, row.static.evidence, tests];
        if (column === "nodeStability") return stability;
        return row[column];
      }),
    );
  }
  const encoded = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "rows") {
      encoded.rowColumns = LEDGER_COLUMNS;
      encoded.stabilities = stabilities;
      encoded.testPaths = testPaths;
      encoded.rows = rows;
    } else {
      encoded[key] = value;
    }
  }
  return encoded;
}

/** The snapshot object the generator and every reader work with, from a
 * parsed ledger (either this format or the older object-row one). */
export function decodeLedger(encoded) {
  if (!Array.isArray(encoded.rowColumns)) return encoded;
  const columns = encoded.rowColumns;
  const rows = encoded.rows.map((values) => {
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      const value = values[i];
      if (column === "static") {
        const [status, evidence, tests] = value;
        row.static = { status, evidence };
        if (tests !== null) row.static.tests = tests.map((at) => encoded.testPaths[at]);
      } else if (column === "nodeStability") {
        row.nodeStability = value === null ? null : encoded.stabilities[value];
      } else {
        row[column] = value;
      }
    }
    return row;
  });
  const snapshot = {};
  for (const [key, value] of Object.entries(encoded)) {
    if (key === "rowColumns" || key === "stabilities" || key === "testPaths") continue;
    snapshot[key] = key === "rows" ? rows : value;
  }
  return snapshot;
}

/** The ledger file's text from a built snapshot. */
export function serializeLedger(snapshot) {
  return `${JSON.stringify(encodeLedger(snapshot))}\n`;
}

/** The snapshot from the ledger file's text. */
export function parseLedger(text) {
  return decodeLedger(JSON.parse(text));
}
