// DEP0187 is reported through process.emitWarning, so a replacement that
// throws propagates out of fs.existsSync. Node records the report as made
// after process.emitWarning returns, so the throw leaves it unrecorded and a
// later invalid value reports again.
import * as fs from "node:fs";

const dynamic: any = JSON.parse("null");
process.emitWarning = ((warning: unknown) => {
  throw new Error(`replaced report: ${String(warning)}`);
}) as typeof process.emitWarning;

try {
  console.log("first:", fs.existsSync(dynamic));
} catch (err) {
  console.log("first threw:", err instanceof Error ? err.message : String(err));
}
try {
  console.log("second:", fs.existsSync(dynamic));
} catch (err) {
  console.log("second threw:", err instanceof Error ? err.message : String(err));
}
