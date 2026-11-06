// @requires-libnode
// process.report is answered by the Node island, which is this same
// process: the diagnostic report is Node's own, so sharedObjects lists the
// libraries the running binary really has loaded. The program needs an
// island for the report to be available at all; a build without one keeps
// the process.report refusal.
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
// Every member the fallback declarations carry, so the ledger's
// island-served rows name evidence that reads them. writeReport and
// excludeEnv are omitted: the fallback @types surface does not declare them
// (a project with @types/node gets them from Node's own declarations), and
// the ledger leaves those two rows unclaimed.
console.log("reportOnFatalError", typeof process.report.reportOnFatalError);
console.log("reportOnSignal", typeof process.report.reportOnSignal);
console.log("reportOnUncaughtException", typeof process.report.reportOnUncaughtException);
console.log("signal", typeof process.report.signal);
