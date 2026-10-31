import { expect, test } from "vitest";
import { filterIcuData, icuDataItemDropped, icuDataItems } from "../scripts/icu-data.mjs";

/** A common data file in ICU's layout: a 32-byte header with the 0xda27
 * magic, the table of contents, the names, and each item at a 16-byte
 * boundary (padded with 0xaa, as ICU's tools pad). */
function dataFile(items: [string, string][]): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt16LE(32, 0);
  header[2] = 0xda;
  header[3] = 0x27;
  const names = Buffer.concat(items.map(([name]) => Buffer.from(`${name}\0`, "latin1")));
  const tocSize = 4 + items.length * 8;
  const toc = Buffer.alloc(tocSize);
  toc.writeUInt32LE(items.length, 0);
  let nameOffset = tocSize;
  let offset = (tocSize + names.length + 15) & ~15;
  const body: Buffer[] = [];
  items.forEach(([name, contents], i) => {
    toc.writeUInt32LE(nameOffset, 4 + i * 8);
    toc.writeUInt32LE(offset, 8 + i * 8);
    nameOffset += name.length + 1;
    const padded = Buffer.alloc((contents.length + 15) & ~15, 0xaa);
    padded.write(contents, "latin1");
    body.push(padded);
    offset += padded.length;
  });
  const lead = Buffer.alloc(((tocSize + names.length + 15) & ~15) - tocSize - names.length, 0xaa);
  return Buffer.concat([header, toc, names, lead, ...body]);
}

const items: [string, string][] = [
  ["icudt78l/brkitr/word.brk", "word rules"],
  ["icudt78l/coll/de.res", "collation"],
  ["icudt78l/curr/de.res", "currencies"],
  ["icudt78l/de.res", "locale"],
  ["icudt78l/ibm-1047_P100-1995.cnv", "converter"],
  ["icudt78l/zone/de.res", "zone names"],
  ["icudt78l/zoneinfo64.res", "time zones"],
];

test("the dropped categories match trees and root-level converters only", () => {
  const dropped = items.map(([name]) => icuDataItemDropped(name));
  expect(dropped).toEqual([false, true, false, false, true, true, false]);
  expect(icuDataItemDropped("icudt78l/brkitr/x.cnv")).toBe(false);
});

test("a filtered file keeps the accepted items' names, order and bytes", () => {
  const file = dataFile(items);
  const filtered = filterIcuData(file, (name) => !icuDataItemDropped(name));
  expect(filtered.subarray(0, 32).equals(file.subarray(0, 32))).toBe(true);
  const kept = icuDataItems(filtered);
  expect(kept.map((item) => item.name)).toEqual([
    "icudt78l/brkitr/word.brk",
    "icudt78l/curr/de.res",
    "icudt78l/de.res",
    "icudt78l/zoneinfo64.res",
  ]);
  for (const item of kept) {
    const [, contents] = items.find(([name]) => name === item.name)!;
    expect(item.bytes.subarray(0, contents.length).toString("latin1")).toBe(contents);
  }
  for (const [i, item] of kept.entries())
    expect(filtered.readUInt32LE(32 + 8 + i * 8) % 16, item.name).toBe(0);
});

test("keeping every item reproduces each item", () => {
  const file = dataFile(items);
  const same = icuDataItems(filterIcuData(file, () => true));
  const original = icuDataItems(file);
  expect(same.length).toBe(original.length);
  for (const [i, item] of same.entries()) {
    expect(item.name).toBe(original[i]!.name);
    expect(item.bytes.subarray(0, 10).equals(original[i]!.bytes.subarray(0, 10))).toBe(true);
  }
});

test("a file without ICU's magic is refused", () => {
  expect(() => icuDataItems(Buffer.alloc(64))).toThrow("not an ICU data file");
});
