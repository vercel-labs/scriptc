// Blob and File values cross a MessageChannel: the receiving side gets a
// Blob (or File) of its own with the same bytes, type, name and time, and
// structuredClone makes the same copy.
import { Blob, Buffer, File } from "node:buffer";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    // Read like an untyped handle: structuredClone's DataCloneError is a
    // DOMException, whose legacy `code` is the number 25.
    const err = e as { name: string; message: string; code?: number };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

const { port1, port2 } = new MessageChannel();
const blob = new Blob(["hello ", "world"], { type: "Text/Plain" });
const file = new File(["body"], "a.txt", { type: "text/plain", lastModified: 99 });

port1.postMessage({ blob, file, list: [blob], nested: { inner: file } });
const received = receiveMessageOnPort(port2)?.message as {
  blob: Blob;
  file: File;
  list: Blob[];
  nested: { inner: File };
};

console.log("blob", received.blob.size, received.blob.type, Buffer.from(await received.blob.arrayBuffer()).toString());
console.log("file", received.file.size, received.file.name, received.file.type, received.file.lastModified, await received.file.text());
console.log("kinds", received.blob instanceof Blob, received.file instanceof File, received.file instanceof Blob);
console.log("copies", received.blob === blob, received.file === file, received.list[0] === blob, received.nested.inner === file);
console.log("inside", received.list[0] === received.blob, received.nested.inner === received.file);
console.log("tags", Object.prototype.toString.call(received.blob), Object.prototype.toString.call(received.file));
console.log("json", JSON.stringify(received.blob), JSON.stringify(received.file));

// structuredClone uses the same copy.
const cloned = structuredClone(blob);
const clonedFile = structuredClone(file);
console.log("clone", cloned instanceof Blob, cloned.size, cloned.type, Buffer.from(await cloned.bytes()).toString());
console.log("clone file", clonedFile instanceof File, clonedFile.name, clonedFile.lastModified, await clonedFile.text());
console.log("clone distinct", cloned === blob, clonedFile === file);

// A Blob is serializable, not transferable.
console.log("transfer", shape(() => structuredClone(blob, { transfer: [blob] })));

// The message keeps working after a slice of the source.
const sliced = blob.slice(6);
port1.postMessage(sliced);
const next = receiveMessageOnPort(port2)?.message as Blob;
console.log("slice sent", next instanceof Blob, next.size, await next.text(), JSON.stringify(next.type));

port1.close();
port2.close();
