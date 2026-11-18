// fs.openAsBlob(path[, options]) answers Node's Blob over a file's bytes:
// the size and type the call saw, text and slice over the bytes, and a
// file that changed (or went away) after the call making every read reject
// with NotReadableError rather than answering different bytes.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-open-as-blob-"));
const file = join(dir, "data.bin");
fs.writeFileSync(file, "0123456789");

// 1. The Blob's shape: the stat's size, the options type, and the bytes.
const blob = await fs.openAsBlob(file, { type: "text/plain" });
console.log("shape", blob.size, blob.type, blob instanceof Blob);
console.log("text", await blob.text(), new Uint8Array(await blob.arrayBuffer()).length);
const part = blob.slice(2, 6);
console.log("slice", part.size, await part.text());

// 2. An empty file is an empty Blob.
const empty = join(dir, "empty.bin");
fs.writeFileSync(empty, "");
const emptyBlob = await fs.openAsBlob(empty);
console.log("empty", emptyBlob.size, JSON.stringify(await emptyBlob.text()));

// 3. The bytes are read when the Blob is read: a file removed afterwards
// keeps the size the call saw and rejects the read.
const gone = join(dir, "gone.bin");
fs.writeFileSync(gone, "abc");
const goneBlob = await fs.openAsBlob(gone);
fs.rmSync(gone);
console.log("gone size", goneBlob.size);
try {
  await goneBlob.text();
  console.log("gone", "read");
} catch (err) {
  console.log("gone", (err as Error).name);
}

// 4. The same for a file rewritten in place.
const changed = join(dir, "changed.bin");
fs.writeFileSync(changed, "AAAA");
const changedBlob = await fs.openAsBlob(changed);
fs.writeFileSync(changed, "BBBB");
try {
  await changedBlob.text();
  console.log("changed", "read");
} catch (err) {
  console.log("changed", (err as Error).name);
}

// 5. A missing path throws at the call, as Node's open does.
try {
  await fs.openAsBlob(join(dir, "nope.bin"));
  console.log("missing", "opened");
} catch (err) {
  console.log("missing", (err as Error).name, (err as { code?: string }).code);
}

// 6. options.type: a truthy non-string is the converter's TypeError, a
// falsy one is the empty type.
const notString: any = JSON.parse("1");
try {
  await fs.openAsBlob(file, { type: notString });
} catch (err) {
  console.log("type", (err as Error).name, (err as { code?: string }).code);
}
const falsyType: any = JSON.parse("0");
const falsy = await fs.openAsBlob(file, { type: falsyType });
console.log("falsy type", JSON.stringify(falsy.type));

// 7. The Blob reads the file its first read opened: a symlink repointed to
// another file afterwards no longer answers, whether or not the new target
// keeps the size.
const link = join(dir, "link.bin");
const firstTarget = join(dir, "first.bin");
const otherTarget = join(dir, "other.bin");
const sameSizeTarget = join(dir, "same-size.bin");
fs.writeFileSync(firstTarget, "linked");
fs.writeFileSync(otherTarget, "a longer file");
fs.writeFileSync(sameSizeTarget, "SAME SIZE");
fs.symlinkSync(firstTarget, link);
const linked = await fs.openAsBlob(link);
console.log("link", await linked.text());
fs.rmSync(link);
fs.symlinkSync(otherTarget, link);
try {
  await linked.text();
  console.log("link swapped", "read");
} catch (err) {
  console.log("link swapped", (err as Error).name);
}
const linkedSameSize = await fs.openAsBlob(link);
console.log("link another", await linkedSameSize.text());
fs.rmSync(link);
fs.symlinkSync(sameSizeTarget, link);
try {
  await linkedSameSize.text();
  console.log("link same size", "read");
} catch (err) {
  console.log("link same size", (err as Error).name);
}

// 8. A file Blob used as a part of a new Blob is read into it.
const wrapped = new Blob([blob]);
console.log("wrap", wrapped.size, await wrapped.text());

// 9. A file-backed Blob cannot be cloned or sent in a message.
try {
  structuredClone(blob);
  console.log("clone", "cloned");
} catch (err) {
  console.log("clone", (err as Error).name, (err as { code?: string }).code);
}

// 10. options.type is a JavaScript property read: an accessor runs, an
// inherited member counts, and the case is kept.
const getterOptions = {
  get type() {
    return "Text/Plain";
  },
};
const getterBlob = await fs.openAsBlob(file, getterOptions);
console.log("getter type", getterBlob.type);
const inherited = await fs.openAsBlob(file, Object.create({ type: "x/Y" }));
console.log("inherited type", inherited.type);
const casing = await fs.openAsBlob(file, { type: "multipart/form-data; boundary=AbC123" });
console.log("case type", casing.type);
const throwing = {
  get type(): string {
    throw new RangeError("boom");
  },
};
try {
  await fs.openAsBlob(file, throwing);
  console.log("getter error", "none");
} catch (err) {
  console.log("getter error", (err as Error).name, (err as Error).message);
}

// 11. An empty file's Blob still checks the file on every read.
const blank = join(dir, "blank.bin");
fs.writeFileSync(blank, "");
const blankBlob = await fs.openAsBlob(blank);
console.log("blank", blankBlob.size, JSON.stringify(await blankBlob.text()));
fs.writeFileSync(blank, "longer");
try {
  await blankBlob.text();
  console.log("blank changed", "read");
} catch (err) {
  console.log("blank changed", (err as Error).name);
}

// 12. An empty slice of a file Blob carries no bytes: it is an ordinary
// empty Blob, reading and cloning freely after the file is gone.
const sliceFile = join(dir, "slice.bin");
fs.writeFileSync(sliceFile, "0123456789");
const sliceBlob = await fs.openAsBlob(sliceFile);
const head = sliceBlob.slice(0, 0);
const middle = sliceBlob.slice(5, 5);
fs.rmSync(sliceFile);
console.log(
  "empty slices",
  head.size,
  JSON.stringify(await head.text()),
  middle.size,
  JSON.stringify(await middle.text()),
);
const emptyClone = structuredClone(head);
console.log("empty slice clone", emptyClone.size, JSON.stringify(await emptyClone.text()));

fs.rmSync(dir, { recursive: true, force: true });
