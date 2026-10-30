// A Readable's buffered queue after its head moved: read(n) across
// entries, unshift into the freed front slot and onto a part-read head,
// setEncoding after takes, and object-mode takes, unshifts and pushes that
// reuse the freed slots.
import { Readable } from "node:stream";

const bytes = new Readable({ read() {} });
for (let i = 0; i < 40; i++) bytes.push(Buffer.from(`c${i};`));
const out: string[] = [];
out.push(String(bytes.read(7)));
out.push(String(bytes.read(4)));
bytes.unshift(Buffer.from("U1;"));
out.push(String(bytes.read(5)));
bytes.unshift(Buffer.from("U2;"));
out.push(String(bytes.read(30)));
bytes.setEncoding("utf8");
out.push(String(bytes.read(9)));
for (let i = 40; i < 60; i++) bytes.push(Buffer.from(`d${i};`));
out.push(String(bytes.read(20)));
out.push(`left ${bytes.readableLength}`);
console.log(out.join("\n"));

const objects = new Readable({ objectMode: true, highWaterMark: 4, read() {} });
for (let i = 0; i < 12; i++) objects.push({ n: i });
const seen: number[] = [];
for (let i = 0; i < 9; i++) seen.push((objects.read() as { n: number }).n);
objects.unshift({ n: 100 });
objects.unshift({ n: 101 });
for (let i = 12; i < 40; i++) objects.push({ n: i });
let row: { n: number } | null;
while ((row = objects.read() as { n: number } | null) !== null) seen.push(row.n);
console.log(seen.join(","));
console.log(`object left ${objects.readableLength}`);
