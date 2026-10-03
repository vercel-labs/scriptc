import { fileURLToPath, fileURLToPathBuffer, pathToFileURL } from "node:url";

function convert(windows: boolean | undefined): void {
  const options = { windows, extra: "ignored" };
  const url = pathToFileURL("C:\\work\\a b#é.txt", options);
  console.log("convert", windows, url.href, JSON.stringify(fileURLToPath(url, options)), fileURLToPathBuffer(url, options).toString("hex"));
}
convert(true);
convert(false);
convert(undefined);

for (const options of [undefined, null, {}, { windows: undefined }, { windows: null }]) {
  console.log("defaults", pathToFileURL("relative", options as any).href === pathToFileURL("relative").href);
  console.log("defaults", fileURLToPath("file:///C:/a", options as any) === fileURLToPath("file:///C:/a"));
  console.log("defaults", fileURLToPathBuffer("file:///C:/a", options as any).equals(fileURLToPathBuffer("file:///C:/a")));
}
const events: string[] = [];
const options = { get windows(): boolean { events.push("get"); return true; } };
function input(): string { events.push("input"); return "file:///C:/work/a%20b"; }
function opts(): typeof options { events.push("options"); return options; }
console.log("getter", fileURLToPath(input(), opts()), events.join(","));
events.length = 0;
console.log("getter", fileURLToPathBuffer(input(), opts()).toString("hex"), events.join(","));
events.length = 0;
console.log("getter", pathToFileURL("C:\\work\\a b", opts()).href, events.join(","));

const stringConverter = fileURLToPath;
const byteConverter = fileURLToPathBuffer;
const urlConverter = pathToFileURL;
console.log("stored", stringConverter("file:///C:/stored", { windows: true }));
console.log("stored", byteConverter("file:///C:/stored", { windows: true }).toString("hex"));
console.log("stored", urlConverter("C:\\stored", { windows: true }).href);
events.length = 0;
console.log("stored-getter", stringConverter("file:///C:/stored", options), events.join(","));
console.log("stored-default", stringConverter("file:///C:/stored") === fileURLToPath("file:///C:/stored"));
console.log("stored-default", byteConverter("file:///C:/stored").equals(fileURLToPathBuffer("file:///C:/stored")));
console.log("stored-default", urlConverter("relative").href === pathToFileURL("relative").href);
