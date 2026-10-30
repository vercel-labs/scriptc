import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DYN_HANDLE_KINDS } from "../../ir/ir.js";
import { DYN_HANDLE_TAG_NUM, TEXT_CODEC_TAG_NUM } from "./dyn.js";

// scr_dyn.h declares the ScrDynHandleTag values in two lists: SCR_DYNH_TAGS
// pins tags to explicit values, and SCR_DYNH_NEW_TAGS names tags added since
// the last pin, which the enum numbers after the largest pinned value. Both
// are sorted by name, so changes that add tags edit different lines. The
// header itself fails to compile on a duplicate or out-of-range value; these
// checks report the same problems by name and keep the backend's numbers in
// step.
const header = readFileSync(new URL("../../../../runtime/src/scr_dyn.h", import.meta.url), "utf8");
const macro = (name: string, param: string) =>
  new RegExp(`#define ${name}\\(${param}\\)(?: \\\\\\n([\\s\\S]*?))?\\n\\n`).exec(header)![1] ?? "";
const pinnedBody = macro("SCR_DYNH_TAGS", "X");
const newBody = macro("SCR_DYNH_NEW_TAGS", "Y");
const unassignedBody = macro("SCR_DYNH_UNASSIGNED", "Z");
const pinned = [...pinnedBody.matchAll(/^\s*X\(([A-Z0-9_]+), (\d+)\)/gm)].map(
  ([, name, value]) => ({
    name: `SCR_DYNH_${name!}`,
    value: Number(value),
  }),
);
const lastPinned = Math.max(...pinned.map((tag) => tag.value));
const added = [...newBody.matchAll(/^\s*Y\(([A-Z0-9_]+)\)/gm)].map(([, name], i) => ({
  name: `SCR_DYNH_${name!}`,
  value: lastPinned + 1 + i,
}));
const tags = [...pinned, ...added];
const unassigned = [...unassignedBody.matchAll(/^\s*Z\((\d+)\)/gm)].map(([, value]) =>
  Number(value),
);
const capacity = Number(/#define SCR_DYNH_CAPACITY (\d+)/.exec(header)![1]);
const rows = (body: string, open: string) =>
  body.split("\n").filter((line) => line.trim().startsWith(open)).length;

test("every pinned ScrDynHandleTag has an explicit value, in name order", () => {
  expect(pinned.length).toBeGreaterThan(0);
  expect(pinned.length).toBe(rows(pinnedBody, "X("));
  expect(pinned.map((tag) => tag.name)).toEqual(pinned.map((tag) => tag.name).toSorted());
});

test("the new tags are listed by name only, in name order", () => {
  expect(added.length).toBe(rows(newBody, "Y("));
  expect(added.map((tag) => tag.name)).toEqual(added.map((tag) => tag.name).toSorted());
});

test("ScrDynHandleTag values are unique and below SCR_DYNH_CAPACITY", () => {
  const owners = new Map<number, string>(unassigned.map((value) => [value, "SCR_DYNH_UNASSIGNED"]));
  expect(owners.size).toBe(unassigned.length);
  for (const { name, value } of tags) {
    expect(owners.get(value), `${name} = ${value}`).toBeUndefined();
    owners.set(value, name);
    expect(value, name).toBeLessThan(capacity);
  }
});

test("every value up to the largest pinned one is a tag or listed as unassigned", () => {
  const used = new Set([...pinned.map((tag) => tag.value), ...unassigned]);
  const gaps = Array.from({ length: lastPinned + 1 }, (_, value) => value).filter(
    (value) => !used.has(value),
  );
  expect(gaps, "add each value to SCR_DYNH_UNASSIGNED with the reason").toEqual([]);
  for (const value of unassigned) expect(value).toBeLessThan(lastPinned);
});

test("the backend's handle tag numbers match pinned tags in scr_dyn.h", () => {
  const values = new Map(pinned.map((tag) => [tag.name, tag.value]));
  for (const [kind, num] of Object.entries(DYN_HANDLE_TAG_NUM)) {
    const tag = DYN_HANDLE_KINDS.get(kind)?.tag;
    expect(tag, kind).toBeDefined();
    expect(values.get(tag!), `${kind} (${tag}) must be pinned with this value`).toBe(num);
  }
});

test("the backend's codec handle tag numbers match pinned tags in scr_dyn.h", () => {
  const values = new Map(pinned.map((tag) => [tag.name, tag.value]));
  expect(values.get("SCR_DYNH_TEXT_DECODER")).toBe(TEXT_CODEC_TAG_NUM.TextDecoder);
  expect(values.get("SCR_DYNH_TEXT_ENCODER")).toBe(TEXT_CODEC_TAG_NUM.TextEncoder);
  expect(values.get("SCR_DYNH_STRING_DECODER")).toBe(TEXT_CODEC_TAG_NUM.StringDecoder);
});
