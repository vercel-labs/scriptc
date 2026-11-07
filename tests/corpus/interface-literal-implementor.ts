// Case L: classes and an object literal implement the interface.
interface Io { read(n: number): string; write(s: string): number }
class Mem implements Io {
  data = "";
  read(n: number): string { return this.data.slice(0, n); }
  write(s: string): number { this.data += s; return s.length; }
}
class Upper implements Io {
  inner: Io;
  constructor(inner: Io) { this.inner = inner; }
  read(n: number): string { return this.inner.read(n).toUpperCase(); }
  write(s: string): number { return this.inner.write(s); }
}
function watched(io: Io, log: string[]): Io {
  return {
    read(n: number): string { log.push(`r${n}`); return io.read(n); },
    write(s: string): number { log.push(`w${s.length}`); return io.write(s); },
  };
}
const log: string[] = [];
const mem = new Mem();
const ios: Io[] = [mem, new Upper(mem), watched(mem, log)];
let n = 0;
for (const io of ios) n += io.write("ab");
console.log(n, ios.map((io) => io.read(4)).join(","), log.join(","));
console.log(ios[0] === mem, ios[2] === ios[2], ios[2] === mem, ios[0] instanceof Mem, ios[2] instanceof Mem);
console.log(Object.keys(ios[2]!).join(","), typeof ios[2]!.read);
