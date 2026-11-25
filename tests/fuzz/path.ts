// node:path, POSIX and Windows flavors: normalize, join, resolve, relative, dirname, basename, extname, parse,
// format, toNamespacedPath, matchesGlob. Mode 0 is POSIX, 1 is Windows. Case fields: two paths.
import * as path from "node:path";
import { type Case, field, mutate, note, noteStr, ri, rnd, seedField } from "./fz.ts";

const DICT: string[] = ["/", "\\", "..", ".", "//", "\\\\", ":", "C:", "?", "*", " ", ".ext", "\u0000", "é", "%2e", "~"];

export function generate(seeds: Case[]): Case {
  const p = mutate(seedField(seeds, 2), DICT, ri(5) + 1).slice(0, 300);
  const q = mutate(seedField(seeds, 2), DICT, ri(3)).slice(0, 300);
  return [String(ri(2)), String(rnd()), p, q];
}

export function execute(c: Case): void {
  const p = field(c, 2);
  const q = field(c, 3);
  try {
    const m = field(c, 0) === "1" ? path.win32 : path.posix;
    noteStr(m.normalize(p));
    noteStr(m.join(p, q));
    noteStr(m.resolve("/base", p, q));
    noteStr(m.relative(p, q));
    noteStr(m.dirname(p));
    noteStr(m.basename(p, q));
    noteStr(m.extname(p));
    note(m.isAbsolute(p) ? 1 : 0);
    const o = m.parse(p);
    noteStr(o.root);
    noteStr(o.dir);
    noteStr(o.base);
    noteStr(o.ext);
    noteStr(o.name);
    noteStr(m.format(o));
    noteStr(m.toNamespacedPath(p));
    note(path.matchesGlob(p, q) ? 1 : 0);
    note(1);
  } catch (e) {
    note(2);
  }
}
