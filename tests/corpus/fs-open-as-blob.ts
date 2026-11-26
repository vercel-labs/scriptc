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

// Node's openAsBlob keeps the type string verbatim, unlike Blob's own type
// setter: non-ASCII characters, tabs and newlines survive.
for (const verbatim of ["caf\u00e9", "a\tb", "text/plain\n", "text/plain; x=caf\u00e9"]) {
  const kept = await fs.openAsBlob(file, { type: verbatim });
  console.log("verbatim type", JSON.stringify(kept.type));
}

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

// 13. A Blob or File built from a file Blob stays lazy: it reads the same
// file, and rejects once the file is gone.
const lazyFile = join(dir, "lazy.bin");
fs.writeFileSync(lazyFile, "lazydata");
const lazy = await fs.openAsBlob(lazyFile);
const wrappedLazy = new Blob([lazy]);
const fileLazy = new File([lazy], "lazy.bin");
fs.rmSync(lazyFile);
try {
  await wrappedLazy.text();
  console.log("lazy blob", "read");
} catch (err) {
  console.log("lazy blob", (err as Error).name);
}
try {
  await fileLazy.text();
  console.log("lazy file", "read");
} catch (err) {
  console.log("lazy file", (err as Error).name);
}

// 14. A class instance is an options record too.
class BlobOptions {
  type = "text/plain";
}
const classBlob = await fs.openAsBlob(file, new BlobOptions());
console.log("class options", classBlob.type);

// 15. A File built from a file-backed File takes the new name without
// keeping (or leaking) the old one, and a Blob built from a File is a Blob.
const renameFile = join(dir, "rename.bin");
fs.writeFileSync(renameFile, "renamed");
const fileBase = new File([await fs.openAsBlob(renameFile)], "base.bin");
const renamedRead = new File([fileBase], "x.bin");
console.log("renames", fileBase.name, renamedRead.name, JSON.stringify(await renamedRead.text()));
const asBlob = new Blob([fileBase]);
console.log("wrap file", asBlob instanceof Blob, asBlob instanceof File);

// Renaming in a function that drops everything it made: the base File's name
// string must be released with it (the sanitized lane's audit counts what is
// still live at exit).
function renameRounds(source: Blob): number {
  const base = new File([source], "base.bin");
  let total = 0;
  for (let i = 0; i < 20; i++) {
    total += new File([base], `copy-${i}.bin`).name.length;
  }
  return total;
}
const rounds = renameRounds(fileBase);
console.log("rename rounds", rounds > 0);

// 16. Several parts and native endings keep a file part lazy: the new Blob
// reads the file when it is read, not when it is built.
const partFile = join(dir, "parts.bin");
fs.writeFileSync(partFile, "0123456789");
const partBlob = await fs.openAsBlob(partFile);
const mixed = new Blob([partBlob, "!"]);
const nativeEndings = new Blob([partBlob], { endings: "native" });
const mixedNative = new Blob([partBlob, "a\r\nb"], { endings: "native" });
const mixedFile = new File([partBlob, "-tail"], "mix.bin");
console.log("mixed", JSON.stringify(await mixed.text()), mixed.size);
console.log("native endings", JSON.stringify(await nativeEndings.text()));
console.log("mixed native", JSON.stringify(await mixedNative.text()));
console.log("mixed file", JSON.stringify(await mixedFile.text()), mixedFile.name, mixedFile.size);
fs.rmSync(partFile);
try { await mixed.text(); console.log("parts mixed", "read"); } catch (err) { console.log("parts mixed", (err as Error).name); }
try { await nativeEndings.text(); console.log("parts native", "read"); } catch (err) { console.log("parts native", (err as Error).name); }
try { await mixedNative.text(); console.log("parts mixed native", "read"); } catch (err) { console.log("parts mixed native", (err as Error).name); }
try { await mixedFile.text(); console.log("parts file", "read"); } catch (err) { console.log("parts file", (err as Error).name); }

// 17. An empty file part of a composed Blob is still checked: the Blob
// rejects once that file changes or goes away.
const emptyPart = join(dir, "empty-part.bin");
fs.writeFileSync(emptyPart, "");
const composed = new Blob([await fs.openAsBlob(emptyPart), "tail"]);
console.log("composed", JSON.stringify(await composed.text()));
fs.writeFileSync(emptyPart, "grew");
try {
  await composed.text();
  console.log("composed changed", "read");
} catch (err) {
  console.log("composed changed", (err as Error).name);
}
fs.writeFileSync(emptyPart, "");
const composedGone = new Blob([await fs.openAsBlob(emptyPart), "tail"]);
fs.rmSync(emptyPart);
try {
  await composedGone.text();
  console.log("composed removed", "read");
} catch (err) {
  console.log("composed removed", (err as Error).name);
}

// 18. A slice of a composed Blob that holds only copied bytes does not
// depend on the file parts outside it.
const headFile = join(dir, "head-empty.bin");
const tailFile = join(dir, "tail.bin");
fs.writeFileSync(headFile, "");
fs.writeFileSync(tailFile, "ABCDE");
const composedFull = new Blob([
  await fs.openAsBlob(headFile),
  "tail",
  await fs.openAsBlob(tailFile),
]);
const copiedOnly = composedFull.slice(0, 4);
console.log(
  "composed whole",
  JSON.stringify(await composedFull.text()),
  JSON.stringify(await copiedOnly.text()),
);
fs.rmSync(headFile);
fs.rmSync(tailFile);
console.log("copied slice", JSON.stringify(await copiedOnly.text()));
try {
  await composedFull.text();
  console.log("composed after", "read");
} catch (err) {
  console.log("composed after", (err as Error).name);
}

fs.rmSync(dir, { recursive: true, force: true });
