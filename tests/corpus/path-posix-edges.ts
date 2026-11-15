// path.posix over separators, dot segments, suffixes, globs and constants:
// every member of the family answers Node for the same inputs, and the
// namespace's own functions are the platform module's on a POSIX target.
import * as path from "node:path";
import * as posix from "node:path/posix";
import { basename, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, toNamespacedPath } from "node:path/posix";

const show = (label: string, value: string): void => console.log(label, JSON.stringify(value));
const ok = (label: string, value: boolean): void => console.log(label, value);

const paths = [
  "", "/", "//", "///", "/a", "a", "a/", "/a/", "/a/b/", "a/b/c.txt", "/a/b/c.tar.gz",
  ".", "..", "./a", "../a", "a/..", "/a//b", "//a//b//", "/foo/..", "foo/../bar",
  "a/../../b", "/./a/./b/", "C:\\a", "C:\\a\\b.txt", "\\\\server\\share\\a", "a\\b",
  "/home/user/dir/file.txt", "dir/sub/", ".hidden", "/.hidden", "file.", "a.b.c",
  "..ext", "/foo/bar.baz/", "x/y.z/..", "unicodé/fïle.tşt", "emoji/😀.png",
];
for (const p of paths) {
  show(`${JSON.stringify(p)} basename`, path.posix.basename(p));
  show(`${JSON.stringify(p)} dirname`, path.posix.dirname(p));
  show(`${JSON.stringify(p)} extname`, path.posix.extname(p));
  show(`${JSON.stringify(p)} normalize`, path.posix.normalize(p));
  ok(`${JSON.stringify(p)} isAbsolute`, path.posix.isAbsolute(p));
  const parsed = path.posix.parse(p);
  console.log(`${JSON.stringify(p)} parse`, parsed.root, parsed.dir, parsed.base, parsed.ext, parsed.name);
  show(`${JSON.stringify(p)} format(parse)`, path.posix.format(parsed));
}

// A suffix is removed only when it is a proper tail of the basename.
for (const [p, suffix] of [
  ["/a/b.txt", ".txt"], ["/a/b.txt", "txt"], ["/a/b.txt", ".TXT"], [".txt", ".txt"],
  ["/a/b.txt", ""], ["/a/b.txt", ".b.txt"], ["/a/b.tar.gz", ".gz"], ["/a/b", "."],
  ["/a/b.", "."], ["/a/b.txt", "/a/b.txt"],
]) {
  show(`basename ${JSON.stringify(p)} ${JSON.stringify(suffix)}`, path.posix.basename(p, suffix));
}

const joinSets = [
  [], [""], ["a"], ["a", "b"], ["/a", "b"], ["a", "..", "b"], ["/a", "/b"],
  ["a/", "b/"], ["a", "", "b"], ["../..", "a"], [".", "a"], ["a", "./b", "../c", "."],
  ["/", "a", "..", "/b"], ["a", "..", "..", "b"], ["/a", "//b"], ["a//b", "//c"],
  ["/a/b", "/c/d"], ["a/b/c", "../../../d"],
];
for (const set of joinSets) {
  show(`join ${JSON.stringify(set)}`, path.posix.join(...set));
  show(`resolve ${JSON.stringify(set)}`, path.posix.resolve("/base", ...set));
}

const relativeSets: [string, string][] = [
  ["/a/b", "/a/b"], ["/a/b", "/a"], ["/a", "/a/b/c"], ["/a/b", "/a/c"], ["a", "b"],
  ["", "a"], ["/a", "b"], ["/", "/a"], ["/a/b/", "/a/b/c/"], ["/a", "/a/b/../c"],
  ["/a/b/c", "/a/b/d/e"], ["/a/b", "/a"], ["//a/b", "//a/c"],
];
for (const [from, to] of relativeSets) {
  show(`relative ${JSON.stringify(from)} ${JSON.stringify(to)}`, path.posix.relative(from, to));
}

// format's `||` defaults: dir over root, base over name + ext, no separator
// when the directory is the root, and a root that wins when there is no dir.
const objects = [
  {}, { root: "/" }, { dir: "/a" }, { base: "c.txt" }, { name: "c" }, { ext: ".txt" },
  { root: "/", dir: "/a" }, { dir: "/a", name: "c", ext: ".txt" },
  { root: "/", dir: "/a", name: "c", ext: ".txt" }, { dir: "/a", base: "c.txt" },
  { dir: "/a", base: "b.txt", name: "c", ext: ".md" }, { name: "c", ext: "txt" },
  { dir: "/a/", name: "c", ext: ".txt" }, { root: "/", dir: "/a/b", base: "c.txt" },
  { root: "", base: "x" }, { dir: "", base: "x" }, { dir: "/", name: "n" },
  { dir: "/", base: "/abs" }, { dir: "rel", name: "n", ext: ".e" },
];
for (const o of objects) {
  show(`format ${JSON.stringify(o)}`, path.posix.format(o));
}

// toNamespacedPath is the identity on POSIX.
for (const p of ["", "/", "a/b", "/a/b", "\\\\?\\C:\\a", "\\\\server\\share\\a", "C:\\a\\b"]) {
  show(`toNamespacedPath ${JSON.stringify(p)}`, path.posix.toNamespacedPath(p));
}

// matchesGlob follows the glob grammar over POSIX separators; a pattern
// that does not compile answers false rather than throwing.
const globs: [string, string][] = [
  ["a/b.ts", "**/*.ts"], ["a/b.ts", "*.js"], ["/x/y.js", "**/*.js"],
  ["a/b/c.txt", "a/*/c.txt"], ["a/b/c.txt", "a/**/c.txt"], ["a", "a"], ["", "*"],
  ["a/b", "**"], ["a\\b.js", "**/*.js"], ["a/b.ts", "b.ts"], ["x/y/z", "**/z"],
  ["a.b", "a?b"], ["a/b/c", "a/*"], ["A/B", "a/b"], ["a", "["], ["a", ""],
  ["a/b", "a/**"], ["a/b/c", "**/b/**"], ["./a", "a"], ["a/", "a"],
];
for (const [p, pattern] of globs) {
  ok(`matchesGlob ${JSON.stringify(p)} ${JSON.stringify(pattern)}`, path.posix.matchesGlob(p, pattern));
}

// The namespace holds the same functions and constants as the module.
ok("basename is module", basename === posix.basename);
ok("dirname is module", dirname === posix.dirname);
ok("extname is module", extname === posix.extname);
ok("format is module", format === posix.format);
ok("isAbsolute is module", isAbsolute === posix.isAbsolute);
ok("join is module", join === posix.join);
ok("normalize is module", normalize === posix.normalize);
ok("parse is module", parse === posix.parse);
ok("relative is module", relative === posix.relative);
ok("resolve is module", resolve === posix.resolve);
ok("toNamespacedPath is module", toNamespacedPath === posix.toNamespacedPath);
show("sep", path.posix.sep);
show("delimiter", path.posix.delimiter);
show("sep is module", path.sep);
