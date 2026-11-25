// Shared prelude of the in-process fuzz targets (tests/fuzz/README.md).
//
// A case is a list of strings: the mode, a salt for the choices a case makes while it runs, then the target's own
// fields. Seeds and regressions are files that hold one case as JSON. Every generated case depends only on
// (seed, iteration), so running the same seed again with `v` prints the case that was running when a run died.
import { readFileSync, readdirSync } from "node:fs";

export type Case = string[];

let s0 = 1;
let s1 = 2;
export function reseed(a: number, b: number): void {
  s0 = (a ^ 0x9e3779b9) | 0;
  s1 = (Math.imul(b, 0x85ebca6b) ^ 0x1234567) | 0;
  if (s0 === 0 && s1 === 0) s1 = 1;
  for (let i = 0; i < 6; i++) rnd();
}
export function rnd(): number {
  let t = s0;
  const u = s1;
  s0 = u;
  t ^= t << 23;
  t ^= t >>> 17;
  t ^= u ^ (u >>> 26);
  s1 = t;
  return (t + u) >>> 0;
}
export function ri(n: number): number {
  return n <= 0 ? 0 : rnd() % n;
}
export function pick(a: string[]): string {
  return a[ri(a.length)] ?? "";
}

const WEIRD: string[] = [
  "\u0000", "\ud800", "\udfff", "😀", "￿", " ", "é", "İ", "﻿", "\u007f", "\u0080",
  "%", "%00", "%zz", "\\", '"', "'", "\r\n", "\n", "\t", " ", "0", "-0", "1e999", "9007199254740993", "-", ".", "/",
  "//", "../", "..\\", ":", "@", "#", "?", "&", "=", "[", "]", "{", "}", "(", ")", "*", "+", "|", "^", "$", ",",
];
export function mutate(seedText: string, dict: string[], rounds: number): string {
  let s = seedText;
  for (let r = 0; r < rounds; r++) {
    const op = ri(9);
    const len = s.length;
    const at = ri(len + 1);
    if (op === 0) s = s.slice(0, at) + pick(dict) + s.slice(at);
    else if (op === 1) s = s.slice(0, at) + s.slice(at + ri(8) + 1);
    else if (op === 2) {
      const piece = s.slice(at, at + ri(16) + 1);
      s = s.slice(0, at) + piece + piece + s.slice(at);
    } else if (op === 3) s = s.slice(0, at) + pick(WEIRD) + s.slice(at);
    else if (op === 4) s = s.slice(0, at) + String.fromCharCode(ri(0x10000)) + s.slice(at + 1);
    else if (op === 5) s = s.slice(0, at) + String.fromCharCode(ri(128)) + s.slice(at + 1);
    else if (op === 6) {
      const piece = pick(dict);
      const n = ri(40) + 2;
      let rep = "";
      for (let k = 0; k < n; k++) rep += piece;
      s = s.slice(0, at) + rep + s.slice(at);
    } else if (op === 7) {
      const b = ri(len + 1);
      const lo = at < b ? at : b;
      const hi = at < b ? b : at;
      s = s.slice(0, lo) + s.slice(hi) + s.slice(lo, hi);
    } else s = s.slice(0, at);
    if (s.length > 4096) s = s.slice(0, 4096);
  }
  return s;
}

// A running checksum of everything a target observed. Node and the compiled program print the same checksum when
// they agree on every result; `c` prints it after each iteration, which finds the first iteration where they differ.
let sum = 0;
let dump = false;
export function note(v: number): void {
  if (dump) console.log(v);
  sum = (Math.imul(sum, 31) + (v | 0)) | 0;
}
export function noteStr(s: string): void {
  if (dump) console.log(JSON.stringify(s));
  let h = s.length;
  const n = s.length < 64 ? s.length : 64;
  for (let i = 0; i < n; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  note(h);
}

/** Field `i` of a case, or "" when the file is shorter than the target expects. */
export function field(c: Case, i: number): string {
  return c[i] ?? "";
}
/** Field `i` of a random seed. */
export function seedField(seeds: Case[], i: number): string {
  const c = seeds[ri(seeds.length)];
  return c === undefined ? "" : field(c, i);
}

function readCase(path: string): Case {
  return JSON.parse(readFileSync(path, "utf8")) as string[];
}
function readCases(directory: string): Case[] {
  const out: Case[] = [];
  const names = readdirSync(directory).sort();
  for (const name of names) {
    if (name.endsWith(".json") && !name.startsWith(".")) out.push(readCase(directory + "/" + name));
  }
  return out;
}

/**
 * The command line every in-process target shares, after the target's name:
 *   replay <file>...                                  run each case file once
 *   fuzz <seeds dir> <seed> <first> <count> [v|c|d]   run generated cases; v prints each case before it runs,
 *                                                     c the checksum after each, d every observed value
 * `generate` builds a case from the seeds; `execute` runs one and never throws.
 */
export function drive(args: string[], generate: (seeds: Case[]) => Case, execute: (c: Case) => void): void {
  const command = args[0] ?? "";
  if (command === "replay") {
    for (let k = 1; k < args.length; k++) {
      const c = readCase(args[k] ?? "");
      reseed(Number(field(c, 1)), 0);
      execute(c);
    }
    console.log("replayed", args.length - 1, "checksum", sum);
    return;
  }
  if (command !== "fuzz" || args.length < 5) {
    console.error("usage: <target> replay <file>... | <target> fuzz <seeds dir> <seed> <first> <count> [v|c|d]");
    process.exit(2);
  }
  const seeds = readCases(args[1] ?? "");
  if (seeds.length === 0) {
    console.error("no seed cases in", args[1]);
    process.exit(2);
  }
  const seed = Number(args[2]);
  const first = Number(args[3]);
  const count = Number(args[4]);
  const flag = args[5] ?? "";
  dump = flag === "d";
  for (let i = first; i < first + count; i++) {
    reseed(seed, i);
    const c = generate(seeds);
    if (flag === "v") console.error(JSON.stringify(c));
    reseed(Number(field(c, 1)), 0);
    execute(c);
    if (flag === "c") console.log(i, sum);
  }
  console.log("ran", count, "checksum", sum);
}
