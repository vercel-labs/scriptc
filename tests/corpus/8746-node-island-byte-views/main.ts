// @requires-libnode
// A typed array, Buffer or DataView is one object on each side of a Node
// island boundary, over one memory: the same view crossing twice is the
// same object (===, Map key, Set, indexOf), in both directions and after a
// round trip; a view keeps its byteOffset and its place in its ArrayBuffer;
// a Buffer stays a Buffer and a Uint8Array does not become one; a write on
// either side is the other side's next read.
import { keep, same, sameAs, put, same2, make, kept, info, bytesOf, elems, write, writeKept, readKept, keptBytes, sum } from "view-pkg";

function t(label: string, f: () => unknown): void {
  try {
    console.log(label + ":", f());
  } catch (e) {
    console.log(label + ": threw", String(e));
  }
}

function part1(): void {
  // A program view crossing into an island and back: one object or several?
  const u8 = new Uint8Array([1, 2, 3, 4]);
  put("u8", u8);
  t("n2i twice", () => sameAs("u8", u8));
  t("n2i same call", () => same2(u8, u8));
  const back = keep(u8);
  t("round trip ===", () => back === u8);
  t("round trip Map", () => new Map<unknown, number>([[u8, 1]]).get(back));
  t("round trip indexOf", () => [u8].indexOf(back));
  t("round trip Set", () => new Set<unknown>([u8]).has(back));
  const sub = u8.subarray(1, 3);
  put("sub", sub);
  t("subarray twice", () => sameAs("sub", sub));
  t("subarray round trip", () => keep(sub) === sub);
  t("subarray is not parent", () => same2(sub, u8));
  const buf = Buffer.from("hello");
  put("buf", buf);
  t("buffer twice", () => sameAs("buf", buf));
  t("buffer round trip", () => keep(buf) === buf);
  const f64 = new Float64Array([1.5, 2.5]);
  put("f64", f64);
  t("f64 twice", () => sameAs("f64", f64));
  t("f64 round trip", () => keep(f64) === f64);
  const dv = new DataView(new ArrayBuffer(8), 2, 4);
  put("dv", dv);
  t("dataview twice", () => sameAs("dv", dv));
  t("dataview round trip", () => keep(dv) === dv);
  const empty = new Uint8Array(0);
  put("empty", empty);
  t("empty twice", () => sameAs("empty", empty));
  t("empty round trip", () => keep(empty) === empty);
  const asUnknown: unknown = u8;
  t("unknown round trip", () => keep(asUnknown) === asUnknown);
  t("same() after keep", () => { keep(u8); return same(u8); });
}
part1();

function part2(): void {
  // An island view arriving in the program: offset, buffer, brand, identity.
  function shape(v: Uint8Array): string { return `${Object.prototype.toString.call(v)} len=${v.length} bo=${v.byteOffset} bl=${v.byteLength} buf=${v.buffer.byteLength} isBuffer=${Buffer.isBuffer(v)} [${Array.from(v).join(",")}]`; }
  for (const kind of ["u8", "u8sub", "u8empty", "u8subempty", "buffer", "bufferPool", "bufferAlloc"]) {
    t(kind + " shape", () => { const s = shape(make<Uint8Array>(kind)); return kind === "bufferPool" ? s.replace(/bo=\d+/, "bo=N").replace(/buf=\d+/, "buf=N") : s; });
    t(kind + " twice", () => make<Uint8Array>(kind) === kept<Uint8Array>());
    t(kind + " back", () => same(make<Uint8Array>(kind)));
    t(kind + " island sees", () => { const s = info(make<Uint8Array>(kind)); return kind === "bufferPool" ? s.replace(/byteOffset=\d+/, "byteOffset=N").replace(/bufLen=\d+/, "bufLen=N") : s; });
  }
  t("i8", () => { const v = make<Int8Array>("i8"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${Array.from(v).join(",")} ${same(v)}`; });
  t("u8c", () => { const v = make<Uint8ClampedArray>("u8c"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${Array.from(v).join(",")} ${same(v)}`; });
  t("u16", () => { const v = make<Uint16Array>("u16"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${Array.from(v).join(",")} ${same(v)}`; });
  t("i16", () => { const v = make<Int16Array>("i16"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${Array.from(v).join(",")} ${same(v)}`; });
  t("u32", () => { const v = make<Uint32Array>("u32"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${Array.from(v).join(",")} ${same(v)}`; });
  t("i32", () => { const v = make<Int32Array>("i32"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${Array.from(v).join(",")} ${same(v)}`; });
  t("f32", () => { const v = make<Float32Array>("f32"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${same(v)}`; });
  t("f64", () => { const v = make<Float64Array>("f64"); return `${Object.prototype.toString.call(v)} ${v.length} ${v.byteOffset} ${v.buffer.byteLength} ${same(v)}`; });
  t("dataview", () => { const v = make<DataView>("dataview"); return `${v instanceof DataView} ${v.byteLength} ${v.byteOffset} ${v.buffer.byteLength} ${v.getUint8(0)} ${same(v)}`; });
  t("unknown u8sub", () => { const v: unknown = make<unknown>("u8sub"); return `${v instanceof Uint8Array} ${Buffer.isBuffer(v)} ${same(v)} ${(v as Uint8Array).byteOffset}`; });
  t("unknown buffer", () => { const v: unknown = make<unknown>("buffer"); return `${v instanceof Uint8Array} ${Buffer.isBuffer(v)} ${same(v)} ${(v as Uint8Array).byteOffset}`; });
}
part2();

function part3(): void {
  // A program view arriving in an island: offset, buffer, brand.
  const ab = new ArrayBuffer(16);
  const all = new Uint8Array(ab);
  for (let i = 0; i < 16; i++) all[i] = i + 1;
  t("u8", () => info(all) + " | " + bytesOf(all));
  t("u8 view", () => info(new Uint8Array(ab, 4, 8)) + " | " + bytesOf(new Uint8Array(ab, 4, 8)));
  t("u8 subarray", () => info(all.subarray(2, 5)) + " | " + bytesOf(all.subarray(2, 5)));
  t("u8 empty", () => info(new Uint8Array(0)));
  t("u8 empty view", () => info(all.subarray(8, 8)));
  t("i8", () => info(new Int8Array(ab, 1, 3)) + " | " + elems(new Int8Array(ab, 1, 3)));
  t("u8c", () => info(new Uint8ClampedArray(ab, 2, 3)));
  t("u16", () => info(new Uint16Array(ab, 2, 3)) + " | " + elems(new Uint16Array(ab, 2, 3)));
  t("i16", () => info(new Int16Array(ab, 4, 2)));
  t("u32", () => info(new Uint32Array(ab, 4, 2)));
  t("i32", () => info(new Int32Array(ab, 8, 2)));
  t("f32", () => info(new Float32Array(ab, 4, 3)));
  t("f64", () => info(new Float64Array(ab, 8, 1)));
  t("dataview", () => info(new DataView(ab, 3, 5)));
  t("Buffer.alloc", () => info(Buffer.alloc(4, 7)) + " | " + bytesOf(Buffer.alloc(4, 7)));
  t("Buffer.from(ab)", () => info(Buffer.from(ab, 2, 6)) + " | " + bytesOf(Buffer.from(ab, 2, 6)));
  t("Buffer subarray", () => info(Buffer.alloc(8, 1).subarray(2, 6)));
  t("Buffer.from(string)", () => info(Buffer.from("hello")).replace(/byteOffset=\d+/, "byteOffset=N").replace(/bufLen=\d+/, "bufLen=N") + " | " + bytesOf(Buffer.from("hello")));
  t("unknown u8", () => { const v: unknown = all.subarray(2, 5); return info(v); });
  t("unknown Buffer", () => { const v: unknown = Buffer.alloc(3); return info(v); });
}
part3();

function part4(): void {
  // One backing store or two? A write on one side after the crossing, read on the other.
  const u8 = new Uint8Array([1, 2, 3, 4]);
  keep(u8);
  u8[0] = 50;
  t("program writes, island reads", () => readKept(0));
  writeKept(1, 60);
  t("island writes, program reads", () => u8[1]);
  write(u8, 2, 70);
  t("island writes through a new crossing", () => u8[2]);
  const sub = u8.subarray(2);
  keep(sub);
  sub[1] = 80;
  t("subarray: program writes, island reads", () => keptBytes() + " / " + bytesOf(u8));
  writeKept(0, 90);
  t("subarray: island writes, parent sees", () => u8[2]);
  const isl = make<Uint8Array>("u8sub");
  isl[0] = 111;
  t("island view: program writes, island reads", () => readKept(0));
  writeKept(1, 112);
  t("island view: island writes, program reads", () => isl[1]);
  t("island view: sum in island", () => sum(isl));
  const buf = Buffer.alloc(4);
  keep(buf);
  buf.writeUInt16BE(0x0102, 0);
  t("buffer: program writes, island reads", () => keptBytes());
  const f64 = new Float64Array(2);
  keep(f64);
  f64[1] = 2.5;
  t("f64: program writes, island reads", () => readKept(1));
  const dv = new DataView(new ArrayBuffer(4));
  keep(dv);
  dv.setUint8(3, 9);
  t("dataview: program writes, island reads", () => keptBytes());
}
part4();
