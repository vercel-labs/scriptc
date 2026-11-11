// Every documented FileHandle overload on one handle family: the three
// read() shapes, the three write() shapes, the vector forms, the whole-file
// forms with encodings and flags, stat with and without bigint, the control
// calls, the stream forms, and the async-dispose protocol. Each line prints
// only values the scratch file decides.
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-fh-overloads-${process.pid}.bin`);

async function main(): Promise<void> {
  fs.writeFileSync(scratch, "abcdefghij");

  // read(buffer, offset, length, position): offset is the offset INTO the
  // buffer, position is the file offset (null reads at the current offset).
  {
    const handle = await open(scratch, "r");
    const view = Buffer.alloc(8, 0x2e);
    const first = await handle.read(view, 2, 3, 0);
    console.log("read pos", first.bytesRead, view.toString(), first.buffer === view);
    const second = await handle.read(view, 0, 4, null);
    console.log("read null pos", second.bytesRead, view.toString());
    const eof = await handle.read(view, 0, 4, 20);
    console.log("read eof", eof.bytesRead, eof.buffer === view);
    await handle.close();
  }

  // read([options]) and read(buffer[, options]).
  {
    const handle = await open(scratch, "r");
    const bare = await handle.read();
    console.log("read opts", bare.bytesRead, bare.buffer.length, bare.buffer.subarray(0, bare.bytesRead).toString());
    const sized = await handle.read({ length: 3, position: 4 });
    console.log("read sized", sized.bytesRead, sized.buffer.toString());
    const target = Buffer.alloc(6, 0x2d);
    const into = await handle.read(target, { offset: 1, length: 2, position: 2 });
    console.log("read into", into.bytesRead, target.toString(), into.buffer === target);
    const end = await handle.read(target, { offset: 0, length: 2, position: 100 });
    console.log("read beyond", end.bytesRead, end.buffer === target);
    await handle.close();
  }

  // write(string[, position[, encoding]]) and the buffer shapes.
  {
    const handle = await open(scratch, "w+");
    const s1 = await handle.write("hi");
    console.log("write string", s1.bytesWritten, s1.buffer === undefined || s1.buffer.toString());
    const s2 = await handle.write("é", 2, "latin1");
    console.log("write string pos", s2.bytesWritten, s2.buffer);
    const s3 = await handle.write("ZZ", null, "utf8");
    console.log("write string null", s3.bytesWritten);
    const buf = Buffer.from("0123456789");
    const w1 = await handle.write(buf, 2, 3, 1);
    console.log("write buf", w1.bytesWritten, w1.buffer === buf);
    const w2 = await handle.write(buf, 4, 2);
    console.log("write buf no pos", w2.bytesWritten, w2.buffer === buf);
    const w3 = await handle.write(buf, 6);
    console.log("write buf offset", w3.bytesWritten);
    const w4 = await handle.write(buf, { offset: 8, length: 2, position: 0 });
    console.log("write buf opts", w4.bytesWritten, w4.buffer === buf);
    const readAll = Buffer.alloc(20);
    const got = await handle.read(readAll, 0, 20, 0);
    console.log("written bytes", got.bytesRead, readAll.subarray(0, got.bytesRead).toString("latin1"));
    await handle.close();
  }

  // readv/writev with positions and the retained array identity.
  {
    const handle = await open(scratch, "w+");
    const parts = [Buffer.from("aa"), Buffer.from("bbb")];
    const w = await handle.writev(parts, 0);
    console.log("writev", w.bytesWritten, w.buffers === parts);
    const slots = [Buffer.alloc(1), Buffer.alloc(4)];
    const r = await handle.readv(slots, 1);
    console.log("readv", r.bytesRead, slots[0]!.toString(), slots[1]!.toString(), r.buffers === slots);
    const tail = await handle.readv([Buffer.alloc(2)]);
    console.log("readv eof", tail.bytesRead);
    await handle.close();
  }

  // readFile/writeFile/appendFile with encodings and flags.
  {
    const handle = await open(scratch, "w");
    await handle.writeFile("héllo");
    await handle.writeFile(Buffer.from("-tail"), "utf8");
    await handle.appendFile("!", "utf8");
    await handle.close();
    const back = await open(scratch, "r");
    console.log("readFile utf8", JSON.stringify(await back.readFile("utf8")));
    console.log("readFile buffer", (await back.readFile()).toString("utf8"));
    const stats = await back.stat();
    console.log("stat size", stats.size, stats.isFile());
    const big = await back.stat({ bigint: true });
    console.log("stat bigint", typeof big.size, typeof big.mtimeNs);
    await back.close();
  }

  // Controls: chmod, truncate, utimes, sync, datasync, fd.
  {
    const handle = await open(scratch, "r+");
    console.log("fd type", typeof handle.fd, handle.fd >= 3);
    await handle.sync();
    await handle.datasync();
    await handle.truncate(4);
    console.log("truncated", (await handle.stat()).size);
    if (process.platform !== "win32") await handle.chmod(0o640);
    await handle.utimes(new Date(0), new Date(1000));
    const timed = await handle.stat();
    console.log("utimes", timed.atime.getTime(), timed.mtime.getTime());
    // A handle's utimes takes a Date or seconds; the string spelling its
    // type allows is rejected, while the path form accepts it.
    try {
      await handle.utimes(2000, "1970-01-01T00:00:03.500Z");
      console.log("utimes string accepted");
    } catch (thrown) {
      const error = thrown as Error;
      console.log("utimes string", error.name, (error as { code?: string }).code, error.message);
    }
    await handle.utimes(2000, 3.5);
    const timed2 = await handle.stat();
    console.log("utimes numbers", timed2.atime.getTime(), timed2.mtime.getTime());
    await handle.close();
  }

  // createReadStream/createWriteStream options and readLines.
  {
    const writer = await open(scratch, "w");
    const out = writer.createWriteStream({ start: 0 });
    out.end("one\ntwo\nthree\n");
    await new Promise<void>((resolve, reject) => {
      out.on("close", () => resolve());
      out.on("error", reject);
    });
    await writer.close();
    const reader = await open(scratch, "r");
    const stream = reader.createReadStream({ start: 4, end: 7, encoding: undefined });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer).toString());
    console.log("read stream", JSON.stringify(chunks.join("")));
    await reader.close();
    const linesHandle = await open(scratch, "r");
    const lines: string[] = [];
    for await (const line of linesHandle.readLines()) lines.push(line);
    console.log("lines", JSON.stringify(lines));
    await linesHandle.close();
  }

  // Explicit close is idempotent, and the async-dispose protocol closes.
  {
    const handle = await open(scratch, "r");
    await handle.close();
    await handle.close();
    console.log("double close ok");
    let disposedFd = -1;
    {
      await using inner = await open(scratch, "r");
      disposedFd = inner.fd;
    }
    console.log("async disposed", disposedFd >= 3);
  }

  fs.unlinkSync(scratch);
}

await main();
