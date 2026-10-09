// Scaling probes: string operations. Usage: strings <case> <n>
let seed = 12345;
function rnd(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function words(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push("w" + (i % 977));
  return parts.join(" ");
}
function concatLoop(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "x";
  return `${s.length}`;
}
function concatNum(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += i + ",";
  return `${s.length}`;
}
function concatRead(n: number): string {
  // Append and read the tail every iteration (rope flatten pathology).
  let s = "";
  let c = 0;
  for (let i = 0; i < n; i++) {
    s += String.fromCharCode(97 + (i % 26));
    c += s.charCodeAt(s.length - 1);
  }
  return `${s.length} ${c}`;
}
function concatThenScan(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + (i % 26));
  let c = 0;
  for (let i = 0; i < s.length; i++) c += s.charCodeAt(i);
  return `${c}`;
}
function concatPrepend(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s = "y" + s;
  return `${s.length}`;
}
function template(n: number): string {
  let total = 0;
  for (let i = 0; i < n; i++) total += `item-${i}: ${i * 2} (${i % 7})`.length;
  return `${total}`;
}
function splitJoin(n: number): string {
  const s = words(n);
  const p = s.split(" ");
  return `${p.length} ${p.join("-").length}`;
}
function splitChars(n: number): string {
  const s = "abcdefghij".repeat(n / 10);
  return `${s.split("").length}`;
}
function replaceOne(n: number): string {
  const s = words(n);
  let t = 0;
  for (let k = 0; k < 10; k++) t += s.replace("w5", "Q").length;
  return `${t}`;
}
function replaceAll(n: number): string {
  const s = words(n);
  return `${s.replaceAll(" ", "_").length} ${s.replaceAll("w1", "ZZZ").length}`;
}
function replaceRegex(n: number): string {
  const s = words(n);
  return `${s.replace(/w(\d)/g, "v$1").length}`;
}
function replaceFn(n: number): string {
  const s = words(n);
  return `${s.replace(/\d+/g, (m) => String(Number(m) + 1)).length}`;
}
function sliceLoop(n: number): string {
  const s = words(n);
  let t = 0;
  for (let i = 0; i + 5 < s.length && i < n * 4; i++) t += s.slice(i, i + 5).length;
  return `${t}`;
}
function substringLoop(n: number): string {
  const s = words(n);
  let t = 0;
  for (let i = 0; i + 5 < s.length && i < n * 4; i++) if (s.substring(i, i + 2) === "w1") t++;
  return `${t}`;
}
function indexOfAll(n: number): string {
  const s = words(n);
  let c = 0;
  let pos = s.indexOf("w12");
  while (pos !== -1) {
    c++;
    pos = s.indexOf("w12", pos + 1);
  }
  return `${c}`;
}
function indexOfMiss(n: number): string {
  const s = words(n);
  let c = 0;
  for (let k = 0; k < 20; k++) c += s.indexOf("zz" + k);
  return `${c}`;
}
function includesLoop(n: number): string {
  const s = words(n);
  let c = 0;
  for (let k = 0; k < 20; k++) if (s.includes("w" + (970 + k))) c++;
  return `${c}`;
}
function padStart(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) t += String(i).padStart(10, "0").length;
  return `${t}`;
}
function repeat(n: number): string {
  let t = 0;
  for (let k = 0; k < 10; k++) t += "ab".repeat(n).length;
  return `${t}`;
}
function upperLower(n: number): string {
  const s = words(n);
  return `${s.toUpperCase().length} ${s.toLowerCase().length}`;
}
function charAtLoop(n: number): string {
  const s = words(n);
  let c = 0;
  for (let i = 0; i < s.length; i++) if (s.charAt(i) === "w") c++;
  return `${c}`;
}
function indexLoop(n: number): string {
  const s = words(n);
  let c = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === " ") c++;
  return `${c}`;
}
function forOfChars(n: number): string {
  const s = words(n);
  let c = 0;
  for (const ch of s) if (ch === "1") c++;
  return `${c}`;
}
function nonAsciiConcat(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += i % 10 === 0 ? "é" : "a";
  let c = 0;
  for (let i = 0; i < s.length; i += 7) c += s.charCodeAt(i);
  return `${s.length} ${c}`;
}
function nonAsciiIndex(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(i % 10 === 0 ? "ü" : "w");
  const s = parts.join("");
  let c = 0;
  for (let i = 0; i < s.length; i++) c += s.charCodeAt(i);
  return `${c}`;
}
function nonAsciiSlice(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(i % 10 === 0 ? "ü" : "w");
  const s = parts.join("");
  let c = 0;
  for (let i = 0; i + 3 < s.length; i++) c += s.slice(i, i + 3).length;
  return `${c}`;
}
function strCompare(n: number): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("key" + Math.floor(rnd() * 1e6));
  let c = 0;
  for (let i = 1; i < n; i++) if (a[i]! < a[i - 1]!) c++;
  return `${c}`;
}
function trimLines(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) t += ("  line " + i + "  ").trim().length;
  return `${t}`;
}
function linesSplit(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`${i},name${i},${i * 3}`);
  const text = lines.join("\n");
  let s = 0;
  for (const line of text.split("\n")) s += Number(line.split(",")[2]);
  return `${s}`;
}
function numToString(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) t += String(i * 1.5).length + (i * 0.1).toFixed(2).length;
  return `${t}`;
}
function parseNums(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) s += parseInt("" + i, 10) + parseFloat(i + ".5");
  return `${s}`;
}
function startsWith(n: number): string {
  const s = words(n);
  const p = s.split(" ");
  let c = 0;
  for (const w of p) if (w.startsWith("w9") || w.endsWith("7")) c++;
  return `${c}`;
}
function localeCompare(n: number): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push("k" + Math.floor(rnd() * 1e6));
  a.sort((x, y) => x.localeCompare(y));
  return `${a[0]} ${a[n - 1]}`;
}

const which = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? "1000");
const t0 = performance.now();
let out = "";
switch (which) {
  case "concat-loop": out = concatLoop(n); break;
  case "concat-num": out = concatNum(n); break;
  case "concat-read": out = concatRead(n); break;
  case "concat-then-scan": out = concatThenScan(n); break;
  case "concat-prepend": out = concatPrepend(n); break;
  case "template": out = template(n); break;
  case "split-join": out = splitJoin(n); break;
  case "split-chars": out = splitChars(n); break;
  case "replace-one": out = replaceOne(n); break;
  case "replace-all": out = replaceAll(n); break;
  case "replace-regex": out = replaceRegex(n); break;
  case "replace-fn": out = replaceFn(n); break;
  case "slice-loop": out = sliceLoop(n); break;
  case "substring-loop": out = substringLoop(n); break;
  case "indexOf-all": out = indexOfAll(n); break;
  case "indexOf-miss": out = indexOfMiss(n); break;
  case "includes": out = includesLoop(n); break;
  case "padStart": out = padStart(n); break;
  case "repeat": out = repeat(n); break;
  case "upper-lower": out = upperLower(n); break;
  case "charAt-loop": out = charAtLoop(n); break;
  case "index-loop": out = indexLoop(n); break;
  case "for-of-chars": out = forOfChars(n); break;
  case "nonascii-concat": out = nonAsciiConcat(n); break;
  case "nonascii-index": out = nonAsciiIndex(n); break;
  case "nonascii-slice": out = nonAsciiSlice(n); break;
  case "str-compare": out = strCompare(n); break;
  case "trim": out = trimLines(n); break;
  case "lines-split": out = linesSplit(n); break;
  case "num-to-string": out = numToString(n); break;
  case "parse-nums": out = parseNums(n); break;
  case "starts-with": out = startsWith(n); break;
  case "locale-compare": out = localeCompare(n); break;
  default: out = "unknown case";
}
const t1 = performance.now();
console.log(which, n, out);
console.error("T=" + (t1 - t0).toFixed(3));
