// url.pathToFileURL, url.fileURLToPath and url.fileURLToPathBuffer:
// percent-encoding, hosts, dot segments, Windows and POSIX options, and the
// arguments Node refuses.
import { fileURLToPath, fileURLToPathBuffer, pathToFileURL } from "node:url";

const fail = (label: string, fn: () => unknown): void => {
  try {
    const value = fn();
    console.log(label, "ok", typeof value, JSON.stringify(value));
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, "throw", e.code, e.name, e.message);
  }
};

// A path becomes a file: URL with the characters a URL reserves escaped.
for (const path of [
  "/a/b", "/a/b c", "/a/b#c", "/a/b?c", "/a/%41", "a/b", ".", "..", "/", "",
  "/a/ü", "/a/😀", "/a/../b", "/a//b", "/a/b/", "/a\\b", "/a/b%20c", "/a/'b'",
]) {
  fail(`pathToFileURL ${JSON.stringify(path)}`, () => pathToFileURL(path).href);
}
fail("pathToFileURL windows", () => pathToFileURL("/a/b c", { windows: true }).href);
fail("pathToFileURL windows drive", () => pathToFileURL("C:\\a\\b", { windows: true }).href);
fail("pathToFileURL windows unc", () => pathToFileURL("\\\\server\\share\\a", { windows: true }).href);
fail("pathToFileURL windows relative", () => pathToFileURL("a\\b", { windows: true }).href);

// A file: URL becomes the path Node reads from it, with escapes decoded.
for (const url of [
  "file:///a/b", "file:///a/b%20c", "file:///a/%41", "file:///a/%2e%2e/b",
  "file://localhost/a/b", "file://host/a/b", "file:///a/ü", "file:///a/😀",
  "file:///", "file:///a/b/", "file:///a/b?x#y", "file:///C:/a",
  "file://server/share/a", "file:///a/%FFb", "file:///a/%00b", "file:///a%2Fb",
]) {
  fail(`fileURLToPath ${url}`, () => fileURLToPath(url));
  fail(`fileURLToPathBuffer ${url}`, () => fileURLToPathBuffer(url));
}
fail("fileURLToPath windows drive", () => fileURLToPath("file:///C:/a/b", { windows: true }));
fail("fileURLToPath windows unc", () => fileURLToPath("file://server/share/a", { windows: true }));
fail("fileURLToPath windows localhost", () => fileURLToPath("file://localhost/C:/a", { windows: true }));
fail("fileURLToPath http", () => fileURLToPath("http://a/b"));
fail("fileURLToPath bad escape", () => fileURLToPath("file:///a%zz"));
fail("fileURLToPath relative", () => fileURLToPath("file://a/b"));

// A URL value is accepted where a string is.
fail("fileURLToPath URL", () => fileURLToPath(new URL("file:///a/%20b")));
fail("fileURLToPathBuffer URL", () => fileURLToPathBuffer(new URL("file:///a/b")));
fail("pathToFileURL round trip", () => fileURLToPath(pathToFileURL("/a/b c")));
