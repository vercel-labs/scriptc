// Strings made from bytes and code units that are not text (0xFF above
// all) by every decoder: each is probed against a Set and a Map that hold a
// unit key, and its UTF-8 bytes are printed.
import { StringDecoder } from "node:string_decoder";
import * as querystring from "node:querystring";

const nullSet = new Set<string | null>([null, "plain"]);
const undefSet = new Set<string | undefined>([undefined, "plain"]);
const both = new Map<string | null | undefined, number>([
  [null, 1],
  [undefined, 2],
]);
let hits = 0;
function check(label: string, make: () => string): void {
  let s: string;
  try {
    s = make();
  } catch (err) {
    console.log(label, "threw", err instanceof Error ? err.name : "?");
    return;
  }
  const hit = nullSet.has(s) || undefSet.has(s) || both.has(s);
  if (hit) hits++;
  const codes: number[] = [];
  for (let i = 0; i < s.length && i < 6; i++) codes.push(s.charCodeAt(i));
  console.log(label, hit ? "HIT" : "ok", s.length, codes.join(","), Buffer.from(s, "utf8").toString("hex"));
}

const raw = Buffer.from([0xff, 0x6e]);
const rawU = Buffer.from([0xff, 0x75]);
const mixed = Buffer.from([0x61, 0xff, 0x6e, 0xc3, 0xbf, 0xed, 0xa0, 0x80, 0xf8, 0x80]);
check("latin1", () => raw.toString("latin1"));
check("latin1 u", () => rawU.toString("latin1"));
check("binary", () => raw.toString("binary"));
check("utf8", () => raw.toString("utf8"));
check("utf-8", () => raw.toString("utf-8"));
check("default", () => raw.toString());
check("ascii", () => raw.toString("ascii"));
check("hex", () => raw.toString("hex"));
check("base64", () => raw.toString("base64"));
check("base64url", () => raw.toString("base64url"));
check("utf16le", () => Buffer.from([0xff, 0x00, 0x6e, 0x00]).toString("utf16le"));
check("ucs2", () => Buffer.from([0xff, 0x00, 0x6e, 0x00]).toString("ucs2"));
check("utf16le odd", () => Buffer.from([0xff, 0x6e, 0xff]).toString("utf16le"));
check("utf16le lone", () => Buffer.from([0x00, 0xd8, 0x6e, 0x00]).toString("utf16le"));
check("mixed utf8", () => mixed.toString("utf8"));
check("mixed latin1", () => mixed.toString("latin1"));
check("mixed ascii", () => mixed.toString("ascii"));
check("range", () => mixed.toString("latin1", 1, 3));
check("subarray", () => mixed.subarray(1, 3).toString("latin1"));
check("String()", () => String(raw));
check("template", () => `${raw}`);
check("concat", () => Buffer.concat([Buffer.from([0xff]), Buffer.from([0x6e])]).toString("latin1"));
check("from latin1", () => Buffer.from("ÿn", "latin1").toString("latin1"));
check("from base64", () => Buffer.from("/24=", "base64").toString("latin1"));
check("from hex", () => Buffer.from("ff6e", "hex").toString("binary"));
check("uint8array", () => Buffer.from(new Uint8Array([0xff, 0x6e]).buffer).toString("latin1"));
check("truncated", () => Buffer.from([0x6e, 0xc3]).toString("utf8"));

check("TextDecoder", () => new TextDecoder().decode(new Uint8Array([0xff, 0x6e])));
check("TextDecoder fatal", () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff, 0x6e])));
check("TextDecoder fatal ok", () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xc3, 0xbf, 0x6e])));
check("TextDecoder mixed", () => new TextDecoder().decode(mixed));
check("TextDecoder latin1", () => new TextDecoder("latin1").decode(new Uint8Array([0xff, 0x6e])));
check("TextDecoder utf-16le", () => new TextDecoder("utf-16le").decode(new Uint8Array([0xff, 0x00, 0x6e, 0x00])));
const streaming = new TextDecoder();
check("TextDecoder stream 1", () => streaming.decode(new Uint8Array([0x6e, 0xc3]), { stream: true }));
check("TextDecoder stream 2", () => streaming.decode(new Uint8Array([0xff, 0x6e]), { stream: true }));
check("TextDecoder stream 3", () => streaming.decode());

const utf8Decoder = new StringDecoder("utf8");
check("StringDecoder utf8", () => utf8Decoder.write(raw));
check("StringDecoder split", () => utf8Decoder.write(Buffer.from([0xc3])) + "|" + utf8Decoder.write(Buffer.from([0xff, 0x6e])));
check("StringDecoder end", () => utf8Decoder.end(Buffer.from([0xe2, 0x82])));
check("StringDecoder latin1", () => new StringDecoder("latin1").write(raw));

check("atob", () => atob("/24="));
check("btoa", () => btoa(atob("/24=")));
check("decodeURIComponent", () => decodeURIComponent("%C3%BFn"));
check("decodeURIComponent bad", () => decodeURIComponent("%FFn"));
check("decodeURI bad", () => decodeURI("%FFn"));
check("encodeURIComponent", () => encodeURIComponent("ÿn"));
check("URLSearchParams", () => new URLSearchParams("a=%FFn").get("a") ?? "none");
check("URL path", () => new URL("http://host/%FFn").pathname);
check("URL decoded", () => decodeURIComponent(new URL("http://host/ÿn").pathname));
check("querystring.unescape", () => querystring.unescape("%FFn"));
check("querystring.parse", () => String(querystring.parse("a=%FFn")["a"]));

check("fromCharCode", () => String.fromCharCode(0xff, 0x6e));
check("fromCharCode wrap", () => String.fromCharCode(0xff + 65536, 0x6e));
check("fromCharCode 0x1ff", () => String.fromCharCode(0x1ff, 0x6e));
check("fromCodePoint", () => String.fromCodePoint(0xff, 0x6e));
check("literal x", () => "\xffn");
check("literal u", () => "ÿu");
check("String.raw", () => String.raw`\xffn`);
check("String.raw parts", () => String.raw({ raw: ["\xff", "n"] }, ""));
check("JSON escape", () => JSON.parse('"\\u00ffn"') as string);
check("JSON latin1 text", () => JSON.parse(Buffer.from([0x22, 0xff, 0x6e, 0x22]).toString("latin1")) as string);
check("JSON utf8 text", () => JSON.parse(Buffer.from([0x22, 0xff, 0x6e, 0x22]).toString("utf8")) as string);
check("JSON key", () => Object.keys(JSON.parse('{"\\u00ffn":1}') as Record<string, number>)[0]);
check("JSON lone", () => JSON.parse('"\\ud800n"') as string);
check("JSON pair", () => JSON.parse('"\\ud83d\\ude00"') as string);
check("JSON stringify", () => JSON.stringify("ÿn\ud800"));

check("lone high", () => "\ud800n");
check("lone low", () => "\udfffn");
check("joined pair", () => "\ud83d" + "\ude00");
check("slice of pair", () => "\u{1f600}n".slice(1));
check("charAt of pair", () => "\u{1f600}".charAt(0) + "n");
check("split", () => "ÿn\u{1f600}".split("").join("|"));
check("upper", () => "ÿn".toUpperCase());
check("normalize", () => "ÿn".normalize("NFD"));
check("wellFormed", () => "\ud800n".toWellFormed());
check("repeat", () => "ÿ".repeat(2) + "n");
check("replace", () => "xn".replace("x", "ÿ"));
check("regex", () => "aÿnb".replace(/[^ÿ-Ān]/g, ""));
check("pad", () => "n".padStart(2, "ÿ"));

let singles = 0;
for (let c = 0; c <= 0xffff; c++) {
  const one = String.fromCharCode(c);
  if (nullSet.has(one + "n") || undefSet.has(one + "u") || both.has(one + "n") || both.has(one + "u") || nullSet.has(one)) singles++;
}
console.log("every code unit", singles);
let bytes = 0;
for (let b = 0; b < 256; b++) {
  for (const tail of [0x6e, 0x75]) {
    const pair = Buffer.from([b, tail]);
    for (const text of [pair.toString("latin1"), pair.toString("utf8"), pair.toString("ascii"), new TextDecoder().decode(pair)]) {
      if (nullSet.has(text) || undefSet.has(text) || both.has(text)) bytes++;
    }
  }
}
console.log("every byte", bytes, "hits", hits);
console.log(nullSet.size, undefSet.size, both.size, nullSet.has(null), undefSet.has(undefined), both.get(null), both.get(undefined));
