import { MessageChannel } from "node:worker_threads";

// A Blob or a File crosses a message by sharing its immutable bytes: the
// receiving side reads the same size, type (and for a File, name and
// lastModified) and the same content.
const { port1, port2 } = new MessageChannel();
let seen = 0;
port1.on("message", async (value: any) => {
  seen += 1;
  if (seen === 1) {
    const blob = value as Blob;
    console.log("blob", blob.size, blob.type, Object.prototype.toString.call(blob), await blob.text());
  } else {
    const file = value as File;
    console.log(
      "file",
      file.size,
      file.type,
      file.name,
      file.lastModified,
      Object.prototype.toString.call(file),
      await file.text(),
    );
    port1.close();
    port2.close();
  }
});
port1.start();
port2.postMessage(new Blob(["hello"], { type: "text/plain" }));
port2.postMessage(new File(["abc"], "x.txt", { type: "text/plain", lastModified: 7 }));
