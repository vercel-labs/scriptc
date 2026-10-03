import { fileURLToPath, fileURLToPathBuffer, pathToFileURL } from "node:url";

function report(label, convert, input, options) {
  try {
    const value = convert(input, options);
    console.log(label, value instanceof URL ? value.href : typeof value === "string" ? JSON.stringify(value) : value.toString("hex"));
  } catch (error) {
    console.log(label, error.name, error.code ?? "", error.message);
  }
}
for (const convert of [fileURLToPath, fileURLToPathBuffer]) {
  for (const input of [undefined, null, 7, true, {}, { href: "file:///C:/fake" }]) {
    report("input", convert, input, { windows: false });
  }
  for (const input of ["invalid", "https://example.com/a", "file://server/share", "file:///no-drive", "file:///1:/path", "file:///%FF:/path"]) {
    report("posix", convert, input, { windows: false });
    report("windows", convert, input, { windows: true });
  }
  for (const windows of [false, true, null, undefined, 0, 1, "", "yes", {}]) {
    report("truthiness", convert, "file:///C:/a", { windows });
  }
  for (const options of [null, undefined, false, 7, "ignored"]) report("options", convert, "file:///C:/a", options);
}
for (const input of [undefined, null, 7, true, {}]) report("path", pathToFileURL, input, { windows: false });
for (const windows of [false, true, null, undefined, 0, 1, "", "yes", {}]) {
  report("path-truthiness", pathToFileURL, "C:\\work\\a", { windows });
}
const failure = new Error("option failed");
let order = "";
const options = { get windows() { order += "get;"; throw failure; } };
for (const convert of [fileURLToPath, fileURLToPathBuffer, pathToFileURL]) {
  order = "";
  try { convert(null, options); }
  catch (error) { console.log("option-first", error === failure, order); }
}
let calls = 0;
const coercible = { toString() { calls++; return "file:///C:/fake"; } };
report("no-coercion", fileURLToPath, coercible, {});
report("no-coercion", fileURLToPathBuffer, coercible, {});
report("no-coercion", pathToFileURL, coercible, {});
console.log("coercions", calls);
order = "";
const urlLike = {
  get href() { order += "href;"; return "unused"; },
  get protocol() { order += "protocol;"; return "file:"; },
  get auth() { order += "auth;"; return undefined; },
  get path() { order += "path;"; return undefined; },
  get hostname() { order += "hostname;"; return ""; },
  get pathname() { order += "pathname;"; return "/C:/like%FF"; },
};
console.log("url-like", fileURLToPathBuffer(urlLike, { get windows() { order += "windows;"; return true; } }).toString("hex"), order);
console.log("recovery", fileURLToPathBuffer("file:///C:/after", { windows: true }).toString("hex"));
