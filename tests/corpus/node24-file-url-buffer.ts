import { fileURLToPath, fileURLToPathBuffer } from "node:url";
import { Buffer } from "node:buffer";

for (const tail of [
  "ascii", "é-水-😀", "%20space", "%00nul", "%25percent", "%23hash", "%3Fquestion",
  "%C3%A9", "%E6%B0%B4", "%F0%9F%98%80", "%FF", "%80", "%C0%AF", "%ED%A0%80",
  "%", "%0", "%GG", "%2F", "%2f", "%5C", "%5c", "%252F", "%E0/%2F", "%E0/%5C",
]) {
  const value = "file:///C:/work/" + tail + "?ignored#ignored";
  for (const windows of [false, true]) {
    const options = { windows };
    const bytes = fileURLToPathBuffer(value, options);
    const fromUrl = fileURLToPathBuffer(new URL(value), options);
    console.log("bytes", windows, tail, Buffer.isBuffer(bytes), bytes.toString("hex"), bytes.equals(fromUrl));
    try { console.log("string", windows, tail, JSON.stringify(fileURLToPath(value, options))); }
    catch (error) {
      if (error instanceof Error) console.log("string-error", windows, tail, error.name, error.message);
    }
  }
}
for (const value of ["file://server/share/a%FF%2F%5C", "file://localhost/C:/a", "file://server/share/é", "file://127.0.0.1/share/a"]) {
  console.log("unc", fileURLToPathBuffer(value, { windows: true }).toString("hex"));
}
for (const value of ["file:///C:/", "file:///%43%3A/path", "file:///%2FC:/path", "file:///%5CC:/path"]) {
  try { console.log("drive", fileURLToPathBuffer(value, { windows: true }).toString("hex")); }
  catch (error) { if (error instanceof Error) console.log("drive-error", error.name, error.message); }
}
const first = fileURLToPathBuffer("file:///C:/copy");
const second = fileURLToPathBuffer("file:///C:/copy");
console.log("independent", first !== second, first.equals(second));
first[0] = 120;
console.log("unshared", first.equals(second));
console.log("default", fileURLToPathBuffer("file:///C:/default").toString() === fileURLToPath("file:///C:/default"));
