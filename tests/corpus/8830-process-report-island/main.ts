// @requires-libnode
// process.report is answered by the Node island, which is this same
// process: the diagnostic report is Node's own, so sharedObjects lists the
// libraries the running binary really has loaded. The program needs an
// island for the report to be available at all; a build without one keeps
// the process.report refusal.
import { unlinkSync } from "node:fs";
import { label, ping } from "reportsupport";

console.log("island", label, ping());
console.log("report", typeof process.report);

const report = process.report.getReport() as {
  header?: unknown;
  sharedObjects?: unknown;
  javascriptHeap?: unknown;
};
console.log("header", typeof report.header === "object" && report.header !== null);
console.log("sharedObjects", Array.isArray(report.sharedObjects));
console.log("heap", typeof report.javascriptHeap === "object" && report.javascriptHeap !== null);
console.log("directory", typeof process.report.directory);
console.log("filename", typeof process.report.filename);
console.log("compact", typeof process.report.compact);
console.log("excludeEnv", typeof process.report.excludeEnv);
// writeReport writes the report to the named file and answers that name;
// the report content is machine-specific, so only the round trip is shown.
const written = process.report.writeReport("report-out.json");
// unlinkSync answers undefined; it cannot be compared (SC1043), so its
// result is shown through typeof instead.
const removed = unlinkSync(written);
console.log("written", written === "report-out.json", typeof removed);
const prelude = process.report.getReport() as { header?: unknown };
console.log("prelude", typeof prelude.header === "object");
const hadEnv = process.report.excludeEnv;
process.report.excludeEnv = !hadEnv;
console.log("envSkipped", "environmentVariables" in process.report.getReport());
process.report.excludeEnv = hadEnv;
// Every member the fallback declarations carry, so the ledger's
// island-served rows name evidence that reads them.
console.log("reportOnFatalError", typeof process.report.reportOnFatalError);
console.log("reportOnSignal", typeof process.report.reportOnSignal);
console.log("reportOnUncaughtException", typeof process.report.reportOnUncaughtException);
console.log("signal", typeof process.report.signal);
