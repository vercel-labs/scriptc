import { mark, read } from "./lib.cjs";
const original: Promise<number> = Promise.resolve(1);
const marked: Promise<number> = mark(original);
console.log(read(marked), read(original), marked === original);
async function typed(p: Promise<number>): Promise<string> { return read(p) + ":" + (await p); }
typed(mark(Promise.resolve(2))).then((s) => console.log(s));
