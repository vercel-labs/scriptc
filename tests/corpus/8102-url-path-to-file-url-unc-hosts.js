// pathToFileURL(path, { windows: true }) parses a UNC servername with the URL
// host parser after dropping tabs and newlines and stopping at '#' and '?':
// forbidden host code points throw ERR_INVALID_URL, and the
// name is lowercased, percent-decoded and read as IPv4 when it ends in a
// number. "~" in a path is percent-encoded.
import url from "node:url";
const paths = [
  "\\\\exa mple\\share\\file.txt",
  "\\\\host name\\share\\file.txt",
  "\\\\host@name\\share\\file.txt",
  "\\\\host:name\\share\\file.txt",
  "\\\\host[name\\share\\file.txt",
  "\\\\host]name\\share\\file.txt",
  "\\\\h<x\\s\\f",
  "\\\\host|x\\s\\f",
  "\\\\HoSt\\s\\f",
  "\\\\host%41\\s\\f",
  "\\\\xn--abc\\s\\f",
  "\\\\1.2.3.4\\s\\f",
  "\\\\0x7f.1\\s\\f",
  "\\\\localhost\\s\\f",
  "\\\\?\\UNC\\Server\\share\\f",
  "\\\\host\tname\\share\\f",
  "\\\\host\nname\\share\\f",
  "\\\\host#name\\share\\f",
  "\\\\host?name\\share\\f",
];
for (const path of paths) {
  try {
    console.log(JSON.stringify(path), url.pathToFileURL(path, { windows: true }).href);
  } catch (e) {
    console.log(JSON.stringify(path), e.name, e.code, e.message);
  }
}
// Node percent-encodes "~" in file paths.
console.log(url.pathToFileURL("/tmp/~user/a~b").href, url.pathToFileURL("C:\\a~b", { windows: true }).href);
