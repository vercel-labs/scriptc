// WHATWG URL parsing and setters, URLSearchParams, the legacy url.parse, querystring, percent coding, IDNA and
// file URL conversion. Case fields: text, base.
import { domainToASCII, domainToUnicode, fileURLToPath, format as urlFormat, parse as legacyParse, pathToFileURL } from "node:url";
import * as qs from "node:querystring";
import { type Case, field, mutate, note, noteStr, ri, rnd, seedField } from "./fz.ts";

const DICT: string[] = [
  "http://", "https://", "file://", "ws://", "//", "/", "\\", "?", "#", "@", ":", "[", "]", "%", "%2e", "%2F", "%00",
  "..", ".", "&", "=", ";", "+", "xn--", "0x", "::", "ffff", "1.2.3.4", "localhost", "\t", "\n", " ", "é",
  "／", "。", "%E2%82", "443", "99999", "-", "_",
];
const BASE = "https://base.example/dir/page?x#y";

export function generate(seeds: Case[]): Case {
  const text = mutate(seedField(seeds, 2), DICT, ri(6) + 1);
  const base = ri(3) === 0 ? mutate(seedField(seeds, 2), DICT, ri(3)) : BASE;
  return [String(ri(8)), String(rnd()), text, base];
}

export function execute(c: Case): void {
  const mode = Number(field(c, 0));
  const text = field(c, 2);
  const base = field(c, 3);
  try {
    if (mode === 0) {
      const u = new URL(text);
      noteStr(u.href);
      noteStr(u.origin);
      noteStr(u.host);
      noteStr(u.pathname);
      noteStr(u.search);
      noteStr(u.hash);
      noteStr(u.username);
      noteStr(u.password);
      noteStr(u.port);
    } else if (mode === 1) {
      const u = new URL(text, base);
      noteStr(u.href);
      noteStr(u.hostname);
      for (const [k, v] of u.searchParams) {
        noteStr(k);
        noteStr(v);
      }
    } else if (mode === 2) {
      const u = new URL(BASE);
      u.pathname = text;
      noteStr(u.href);
      u.search = text;
      noteStr(u.href);
      u.hash = text;
      noteStr(u.href);
      u.host = text;
      noteStr(u.href);
      u.port = text;
      noteStr(u.href);
      u.protocol = text;
      noteStr(u.href);
      u.username = text;
      u.password = text;
      u.hostname = text;
      noteStr(u.href);
    } else if (mode === 3) {
      const p = new URLSearchParams(text);
      p.sort();
      noteStr(p.toString());
      p.append(text, base);
      p.delete("x");
      noteStr(p.get("a") ?? "n");
      note(p.getAll("a").length);
    } else if (mode === 4) {
      const p = legacyParse(text, true);
      noteStr(p.href);
      noteStr(p.host ?? "n");
      noteStr(p.pathname ?? "n");
      noteStr(p.auth ?? "n");
      noteStr(urlFormat(p));
    } else if (mode === 5) {
      const o = qs.parse(text);
      note(Object.keys(o).length);
      noteStr(qs.stringify(o));
      noteStr(qs.escape(text));
      noteStr(qs.unescape(text));
    } else if (mode === 6) {
      noteStr(decodeURIComponent(text));
      noteStr(encodeURIComponent(text));
      noteStr(decodeURI(text));
      noteStr(encodeURI(text));
    } else {
      noteStr(domainToASCII(text));
      noteStr(domainToUnicode(text));
      noteStr(URL.canParse(text, base) ? "y" : "n");
      noteStr(fileURLToPath(text));
      noteStr(pathToFileURL(text).href);
    }
    note(1);
  } catch (e) {
    note(2);
  }
}
