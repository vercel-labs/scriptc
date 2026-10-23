// @requires-libnode
// A Node island package used from both sides: a natively compiled package
// requires it; island-declared interfaces type native objects too (member
// operations follow the value, not the declared type); options built with
// spread and method members cross in by reference; a `string | Buffer`
// member reads back from an island object; a rejection's error is read in
// a native callback.
import { twice } from "wraplib";
import {
  countFiles,
  describeFile,
  blob,
  text,
  render,
  failLater,
  type Files,
  type File,
  type FailError,
} from "islandlib";

console.log("twice", twice(5));

const files: Files = {};
files["a.txt"] = { mode: 420, data: "alpha" };
files["b.txt"] = blob("beta");
console.log("files", countFiles(files), files["a.txt"]!.mode, Object.keys(files).join(","));
const local: File = files["a.txt"]!;
console.log("local", local.mode, describeFile(local), describeFile(files["b.txt"]!));

const fromIsland = blob("gamma");
const data = fromIsland.data;
console.log("buffer", typeof data === "string" ? data : data.toString("utf8"), describeFile(text("delta")));

const base = { name: "job", retries: 1 };
console.log(
  "render",
  render({
    ...base,
    retries: 3,
    format(name: string): string {
      return name.toUpperCase();
    },
  }),
);

failLater("nope").catch((e: unknown) => {
  const err = e as FailError;
  console.log("caught", err.message, err.code, (e as { message?: string }).message);
});
