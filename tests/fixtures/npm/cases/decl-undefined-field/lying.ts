// The same run-time table with its keys PRESENT in the line: the package's
// declaration says `undefined` and the reader answers strings. The boundary's
// check throws at each such read; a key the line does not name still reads
// undefined. Node does not check, so this program is native-only
// (tests/harness/decl-boundary.test.ts).
import { readLine, type Fields } from "kv-line";

const text = (value: string): string => value;
const fields: Fields = {};
fields["observer"] = text;
fields["site"] = text;
fields["remark"] = text;
const row = readLine(fields, "observer=mira;site=ridge");

function attempt(label: string, run: () => string): void {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, "threw", (error as Error).name, (error as Error).message);
  }
}
attempt("absent", () => row["remark"] ?? "none");
attempt("compared", () => (row["observer"] === "mira" ? "mira" : "other"));
attempt("tested", () => (row["site"] ? "sited" : "unsited"));
attempt("asserted", () => (row["observer"] as string | undefined) ?? "none");
