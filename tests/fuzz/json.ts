// JSON.parse into unknown, typed records, typed arrays and a union; revivers; JSON.stringify with replacers and
// indentation. Case fields: text.
import { type Case, field, mutate, note, noteStr, ri, rnd, seedField } from "./fz.ts";

interface Item {
  id: number;
  name: string;
  tags: string[];
  meta: { ok: boolean; score: number | null };
  opt?: string;
}
type U = { kind: "a"; x: number } | { kind: "b"; y: string[] };

const DICT: string[] = [
  '"', "{", "}", "[", "]", ":", ",", "null", "true", "false", "\\u", "\\ud800", "\\", "1e", "-", "0.", '"id":',
  '"name":', '"tags":', '"meta":', '"kind":"a"', '"kind":"b"', '"__proto__":', "[[[[", '{"a":', " ", "\n", "1e400",
  "-0", "0x1", "NaN", "Infinity", "/*", "﻿",
];

export function generate(seeds: Case[]): Case {
  const text = mutate(seedField(seeds, 2), DICT, ri(6) + 1);
  return [String(ri(6)), String(rnd()), text];
}

export function execute(c: Case): void {
  const mode = Number(field(c, 0));
  const text = field(c, 2);
  try {
    if (mode === 0) {
      const v: unknown = JSON.parse(text);
      noteStr(JSON.stringify(v) ?? "u");
    } else if (mode === 1) {
      const v = JSON.parse(text) as Item;
      note(v.id | 0);
      noteStr(v.name);
      note(v.tags.length);
      note(v.meta.ok ? 1 : 0);
      noteStr(JSON.stringify(v));
    } else if (mode === 2) {
      const v = JSON.parse(text) as Item[];
      note(v.length);
      for (const it of v) {
        noteStr(it.name);
        note(it.tags.length);
      }
    } else if (mode === 3) {
      const v = JSON.parse(text) as U;
      if (v.kind === "a") note(v.x | 0);
      else note(v.y.length);
    } else if (mode === 4) {
      const v: unknown = JSON.parse(text, (k: string, val: unknown): unknown =>
        k === "tags" ? undefined : val,
      );
      noteStr(JSON.stringify(v, null, 2) ?? "u");
    } else {
      const v = JSON.parse(text) as Record<string, unknown>;
      const keys = Object.keys(v);
      note(keys.length);
      for (const k of keys) noteStr(k);
      noteStr(JSON.stringify(v, ["id", "name"], "\t") ?? "u");
    }
    note(1);
  } catch (e) {
    note(2);
  }
}
