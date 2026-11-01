// pathToFileURL drops a trailing run of C0 control bytes: the URL parser
// strips them from its input, so they do not become %XX escapes. The bytes
// Node pre-encodes (tab, LF, CR) keep their escapes, the NUL byte encodes
// to %00, and a trailing space is a URL %20 (not trimmed). Interior control
// bytes always encode. The URL constructor itself trims trailing C0/space.
import * as url from "node:url";

const cases: string[] = [
  "/tmp/a\u0001",
  "/tmp/a\u0001\u0001",
  "/tmp/a\u001f",
  "/tmp/a ",
  "/tmp/a\u0001 ",
  "/tmp/a \u0001",
  "/tmp/a\u0001\t",
  "/tmp/\u0000",
  "/tmp/\u0001",
  "/tmp/\u0000\u0001",
  "/tmp/a\t",
  "/tmp/a\n",
  "/tmp/a\r",
  "/tmp/a\u0001b",
  "/tmp/a\u0002\u0003b",
  "/tmp/a\u0001/",
];
for (const path of cases) {
  console.log(
    JSON.stringify(path),
    "=>",
    JSON.stringify(url.pathToFileURL(path).href),
    "| win",
    JSON.stringify(url.pathToFileURL(path, { windows: true }).href),
    "| back",
    JSON.stringify(url.fileURLToPath(url.pathToFileURL(path))),
  );
}

const unc = "\\\\server\\share\\res";
console.log(
  "unc",
  JSON.stringify(url.pathToFileURL(unc + "\u0001", { windows: true }).href),
  JSON.stringify(url.pathToFileURL(unc + "\u0001\u0010", { windows: true }).href),
  JSON.stringify(url.pathToFileURL(unc + "\u0000", { windows: true }).href),
);

for (const input of ["file:///tmp/a\u0001", "file:///tmp/a ", "file:///tmp/\u0000"]) {
  console.log("url", JSON.stringify(input), JSON.stringify(new URL(input).href));
}
