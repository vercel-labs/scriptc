// @requires-libnode
// The ArrayBuffer under a view crosses a Node island boundary as one
// object per storage: two views of one buffer still share it on the other
// side, `view.buffer` is the buffer the other side made, and an
// ArrayBuffer value crosses as itself, over the same memory.
import { keep, kept, same, sameBuffer, pair, pairA, pairB, make, bufferInfo, bufferBytes, writeBuffer, readKept, same2, cloneIn } from "buffer-pkg";

function t(label: string, f: () => unknown): void {
  try {
    console.log(label + ":", f());
  } catch (e) {
    console.log(label + ": threw", String(e));
  }
}

function part1(): void {
  // The ArrayBuffer under a view: one buffer for two views, on both sides.
  const ab = new ArrayBuffer(8);
  const a = new Uint8Array(ab, 0, 4), b = new Uint8Array(ab, 4, 4);
  t("program views, island: a.buffer === b.buffer", () => sameBuffer(a, b));
  t("program views: same after round trip", () => keep(a).buffer === b.buffer);
  t("program view .buffer is the program buffer", () => keep(a).buffer === ab);
  pair();
  const ia = pairA(), ib = pairB();
  t("island views, program: a.buffer === b.buffer", () => ia.buffer === ib.buffer);
  t("island views, island: a.buffer === b.buffer", () => sameBuffer(ia, ib));
  t("island view .buffer twice", () => ia.buffer === ia.buffer);
  t("island view's buffer back in the island", () => { keep(ia.buffer); return sameBuffer({ buffer: kept<unknown>() }, ia); });
  t("program buffer into island", () => bufferInfo(ab));
  t("program buffer twice", () => { keep(ab); return same(ab); });
  t("program buffer round trip", () => keep(ab) === ab);
  t("program buffer is its view's", () => same2(ab, a.buffer));
  t("island writes program buffer", () => { writeBuffer(ab, 5, 42); return b[1]; });
  t("island reads program buffer", () => { a[0] = 7; return bufferBytes(ab); });
  const iab = make<ArrayBuffer>("arraybuffer");
  t("island buffer in program", () => `${iab instanceof ArrayBuffer} ${iab.byteLength}`);
  t("island buffer twice", () => make<ArrayBuffer>("arraybuffer") === kept<ArrayBuffer>());
  t("island buffer back", () => same(make<ArrayBuffer>("arraybuffer")));
  t("island buffer: program view writes, island reads", () => { const m = make<ArrayBuffer>("arraybuffer"); new Uint8Array(m)[0] = 100; return bufferBytes(kept<unknown>()).split(",")[0]; });
  t("island buffer: program view reads", () => new Uint8Array(make<ArrayBuffer>("arraybuffer"))[1]);
  t("island buffer of island view", () => { const v = make<Uint8Array>("u8sub"); return v.buffer.byteLength; });
}
part1();

function part2(): void {
  // Values beside plain views that keep Node's answers: a clone is a fresh
  // object, and a buffer the program's typed arrays cannot stand on stays the
  // island's object.
  t("island structuredClone of a program view", () => { const v = new Uint8Array([1, 2, 3, 4]); return cloneIn(v) + ` ${v[0]}`; });
  t("program structuredClone of an island view", () => { const v = make<Uint8Array>("u8sub"); const c = structuredClone(v); c[0] = 99; return `${c === v} ${v[0]} ${c[0]} ${c.byteOffset} ${c.length}`; });
  t("island SharedArrayBuffer", () => { const v = make<SharedArrayBuffer>("sab"); return `${v.byteLength} ${v instanceof SharedArrayBuffer} ${same(v)}`; });
  t("island BigInt64Array", () => { const v = make<unknown>("big64"); return `${Object.prototype.toString.call(v)} ${same(v)} ${String((v as any)[0])} ${(v as any).length}`; });
  t("island view of a SharedArrayBuffer", () => { const v = make<unknown>("sabview"); return `${Object.prototype.toString.call(v)} ${same(v)} ${(v as any).length} ${(v as any).byteOffset}`; });
  t("island view of a resizable buffer", () => { const v = make<unknown>("resizable"); return `${Object.prototype.toString.call(v)} ${same(v)} ${(v as any).length}`; });
}
part2();
