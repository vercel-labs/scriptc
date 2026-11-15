// path.win32 over drive-relative paths, UNC shares, device paths, mixed
// separators, case-insensitive comparison and the namespace rules for
// namespaced paths, on any host.
import * as path from "node:path";
import * as win32 from "node:path/win32";
import { basename, delimiter, dirname, extname, format, isAbsolute, join, matchesGlob, normalize, parse, relative, resolve, sep, toNamespacedPath } from "node:path/win32";

const show = (label: string, value: string): void => console.log(label, JSON.stringify(value));
const ok = (label: string, value: boolean): void => console.log(label, value);

const paths = [
  "", "/", "\\", "//", "\\\\", "C:", "C:\\", "c:", "C:\\a", "C:\\a\\", "a", "a\\b",
  "a/b\\c.d", "\\a", "\\a\\b", "\\\\server", "\\\\server\\", "\\\\server\\share",
  "\\\\server\\share\\", "\\\\server\\share\\a\\b.c", "\\\\?\\C:\\x.y",
  "\\\\?\\UNC\\server\\share\\a", "\\\\.\\COM1", "C:\\path\\dir\\file.txt",
  "C:/mixed/sep/f.e", "C:\\..\\x", "d:\\a\\..", "dir\\", ".\\.git", "C:\\.hidden",
  "C:\\foo\\bar.baz\\", "unicodé\\fïle.tşt", "emoji\\😀.png", "C:\\a\\\\b",
  "\\\\?\\", "C:\\a\\b\\..\\..\\c",
];
for (const p of paths) {
  show(`${JSON.stringify(p)} basename`, path.win32.basename(p));
  show(`${JSON.stringify(p)} dirname`, path.win32.dirname(p));
  show(`${JSON.stringify(p)} extname`, path.win32.extname(p));
  show(`${JSON.stringify(p)} normalize`, path.win32.normalize(p));
  ok(`${JSON.stringify(p)} isAbsolute`, path.win32.isAbsolute(p));
  const parsed = path.win32.parse(p);
  console.log(`${JSON.stringify(p)} parse`, parsed.root, parsed.dir, parsed.base, parsed.ext, parsed.name);
  show(`${JSON.stringify(p)} format(parse)`, path.win32.format(parsed));
}

for (const [p, suffix] of [
  ["C:\\a\\b.txt", ".txt"], ["C:\\a\\b.txt", "txt"], ["C:\\a\\b.txt", ".TXT"],
  ["C:\\a\\b.txt", ""], ["C:\\a\\b.tar.gz", ".gz"], ["\\a\\b.", "."],
  ["\\\\server\\share\\b.txt", ".txt"], ["C:\\b.txt", "\\b.txt"],
]) {
  show(`basename ${JSON.stringify(p)} ${JSON.stringify(suffix)}`, path.win32.basename(p, suffix));
}

const joinSets = [
  [], [""], ["a"], ["a", "b"], ["C:\\a", "b"], ["C:\\a", "..\\b"], ["C:\\a", "D:\\b"],
  ["\\\\server\\share", "a"], ["a\\b", "..\\c"], ["\\a", "b"], ["a\\", "b\\"],
  ["C:", "a"], ["C:", "\\a"], ["C:\\", ".."], ["a", "..", "..", "b"],
  ["\\\\server\\share\\a", "..\\..\\b"], ["/a/b", "c"], ["a/b", "c/d"],
];
for (const set of joinSets) {
  show(`join ${JSON.stringify(set)}`, path.win32.join(...set));
  show(`resolve ${JSON.stringify(set)}`, path.win32.resolve("C:\\base", "D:\\other", ...set));
}

const relativeSets: [string, string][] = [
  ["C:\\a\\b", "C:\\a\\b"], ["C:\\a\\b", "C:\\a"], ["C:\\a", "C:\\a\\b\\c"],
  ["C:\\a\\b", "C:\\a\\c"], ["C:\\a\\b", "D:\\c"], ["\\\\server\\share\\a", "\\\\server\\share\\b"],
  ["\\\\server\\share\\a", "\\\\other\\share\\b"], ["C:\\A\\B", "c:\\a\\b"],
  ["C:\\a\\b\\", "C:\\a\\b\\c\\"], ["C:\\a", "c:\\a\\b\\..\\c"], ["C:", "C:\\a"],
  ["C:\\ΣΑΣ\\a", "c:\\σας\\b"], ["C:\\İ\\a", "c:\\i̇\\a\\b"], ["C:\\Ⱥ\\x", "c:\\ⱥ\\x\\z"],
];
for (const [from, to] of relativeSets) {
  show(`relative ${JSON.stringify(from)} ${JSON.stringify(to)}`, path.win32.relative(from, to));
}

const objects = [
  {}, { root: "C:\\" }, { dir: "C:\\a" }, { base: "c.txt" }, { name: "c" }, { ext: ".txt" },
  { root: "C:\\", dir: "C:\\a" }, { dir: "C:\\a", name: "c", ext: ".txt" },
  { root: "C:\\", dir: "C:\\a", name: "c", ext: ".txt" }, { dir: "C:\\a", base: "c.txt" },
  { dir: "C:\\a", base: "b.txt", name: "c", ext: ".md" }, { name: "c", ext: "txt" },
  { dir: "C:\\a\\", name: "c", ext: ".txt" }, { dir: "\\\\server\\share\\a", base: "b" },
  { root: "\\\\server\\share\\", dir: "\\\\server\\share\\a", name: "n" },
  { root: "", base: "x" }, { dir: "", base: "x" }, { dir: "C:\\", base: "\\abs" },
  { dir: "rel", name: "n", ext: ".e" },
];
for (const o of objects) {
  show(`format ${JSON.stringify(o)}`, path.win32.format(o));
}

// A namespaced path is produced for absolute paths past a drive root; a
// path that already carries the prefix, a UNC path and a short relative
// path answer as Node does.
for (const p of [
  "", "C:", "C:\\", "C:\\a", "C:\\a\\b", "\\\\server\\share\\a", "\\\\?\\C:\\a",
  "\\\\?\\UNC\\server\\share\\a", "\\\\.\\COM1", "a\\b", "\\a",
]) {
  show(`toNamespacedPath ${JSON.stringify(p)}`, path.win32.toNamespacedPath(p));
}

const globs: [string, string][] = [
  ["C:\\a\\b.js", "**/*.js"], ["a\\b.js", "**/*.js"], ["a/b.js", "**/*.js"],
  ["C:\\a\\b.ts", "*.ts"], ["a\\b\\c.txt", "a/*/c.txt"], ["a\\b\\c.txt", "a/**/c.txt"],
  ["a", "a"], ["", "*"], ["a\\b", "**"], ["A\\B", "a/b"], ["C:\\a", "C:/a"],
  ["a\\b", "["], ["a\\b", ""], ["a\\b\\c", "**\\b\\**"],
];
for (const [p, pattern] of globs) {
  ok(`matchesGlob ${JSON.stringify(p)} ${JSON.stringify(pattern)}`, path.win32.matchesGlob(p, pattern));
}

// The namespace holds the same functions and constants as the module.
ok("basename is module", basename === win32.basename);
ok("delimiter is module", delimiter === win32.delimiter);
ok("dirname is module", dirname === win32.dirname);
ok("extname is module", extname === win32.extname);
ok("format is module", format === win32.format);
ok("isAbsolute is module", isAbsolute === win32.isAbsolute);
ok("join is module", join === win32.join);
ok("matchesGlob is module", matchesGlob === win32.matchesGlob);
ok("normalize is module", normalize === win32.normalize);
ok("parse is module", parse === win32.parse);
ok("relative is module", relative === win32.relative);
ok("resolve is module", resolve === win32.resolve);
ok("sep is module", sep === win32.sep);
ok("toNamespacedPath is module", toNamespacedPath === win32.toNamespacedPath);
ok("_makeLong is toNamespacedPath", win32._makeLong === win32.toNamespacedPath);
show("sep", path.win32.sep);
show("delimiter", path.win32.delimiter);
show("posix sep", path.posix.sep);
