// The trace flags are plain writable properties — undefined until assigned —
// and the warning reporter reads them live: traceProcessWarnings traces every
// warning, traceDeprecation only the deprecation ones, and a traced report
// prints the warning's stack in place of the "(node:pid) Name: message"
// heading and the one-time --trace-warnings hint.
import { spawnSync } from "node:child_process";

const mode = process.argv[2];

if (mode === "child-none" || mode === "child-process" || mode === "child-derp") {
  console.log(
    "initial",
    process.traceDeprecation,
    process.traceProcessWarnings,
    process.noDeprecation,
    process.throwDeprecation,
  );
  if (mode === "child-process") process.traceProcessWarnings = true;
  if (mode === "child-derp") process.traceDeprecation = true;
  console.log("now", process.traceDeprecation, process.traceProcessWarnings);
  process.emitWarning("alpha-warning", "Warning");
  process.emitWarning("beta-deprecation", "DeprecationWarning");
} else {
  for (const child of ["child-none", "child-process", "child-derp"]) {
    const result = spawnSync(process.execPath, [process.argv[1], child], { encoding: "utf8" });
    const err = result.stderr;
    const heading = (name: string) =>
      new RegExp(`^\\(node:\\d+\\) ${name}: `, "m").test(err);
    const traced = (name: string) => new RegExp(`^${name}: `, "m").test(err);
    console.log(child, result.status);
    console.log(" stdout", JSON.stringify(result.stdout));
    console.log(
      " headings",
      heading("Warning"),
      heading("DeprecationWarning"),
      traced("Warning"),
      traced("DeprecationWarning"),
      /trace-warnings/.test(err),
      /is deprecated/.test(err),
    );
  }
}
