// Number parsing and formatting: Number, parseFloat, parseInt, toFixed, toPrecision, toExponential, toString with
// a radix, BigInt, util.format and util.inspect. Case fields: text, a number, a digit count, a radix.
import { format, inspect } from "node:util";
import { type Case, field, mutate, note, noteStr, pick, ri, rnd, seedField } from "./fz.ts";

const DICT: string[] = ["e", "E", "+", "-", ".", "0x", "0b", "0o", "Infinity", "NaN", "_", " ", "n", "9", "0", "1e", "\t", "﻿"];
const FMT: string[] = ["%s", "%d", "%i", "%f", "%j", "%o", "%O", "%c", "%%", "%x", "%", "%s%s%s", "%5d", "%o%j"];

export function generate(seeds: Case[]): Case {
  const text = mutate(seedField(seeds, 2), DICT, ri(4) + 1).slice(0, 80);
  const x = ri(4) === 0 ? Number(text) : (rnd() / 4294967296) * Math.pow(10, ri(40) - 20) * (ri(2) === 0 ? -1 : 1);
  return [String(ri(8)), String(rnd()), text, String(x), String(ri(110) - 5), String(ri(40))];
}

export function execute(c: Case): void {
  const mode = Number(field(c, 0));
  const text = field(c, 2);
  const x = Number(field(c, 3));
  const d = Number(field(c, 4));
  const radix = Number(field(c, 5));
  try {
    if (mode === 0) {
      note(Number(text) | 0);
      note(parseFloat(text) | 0);
      note(parseInt(text, radix) | 0);
      noteStr(String(Number(text)));
    } else if (mode === 1) noteStr(x.toFixed(d));
    else if (mode === 2) noteStr(x.toPrecision(d));
    else if (mode === 3) noteStr(x.toExponential(d));
    else if (mode === 4) noteStr(x.toString(radix));
    else if (mode === 5) {
      noteStr(String(BigInt(text)));
      noteStr(BigInt(text).toString(radix < 2 ? 2 : radix > 36 ? 36 : radix));
    } else if (mode === 6) noteStr(format(pick(FMT) + text, x, text, d));
    else {
      noteStr(
        inspect({ x, text, d: [d, radix], n: null }, { depth: ri(3), breakLength: ri(80), maxStringLength: ri(20) }),
      );
    }
    note(1);
  } catch (e) {
    note(2);
  }
}
