// The typed spelling of buffer.resolveObjectURL: Node's declaration takes a
// string id and answers Blob | undefined. A compiled program cannot create a
// blob URL, so the documented argument misses and the answer is undefined.
import { Buffer, resolveObjectURL } from "node:buffer";
import * as bufferModule from "node:buffer";

const id = "blob:nodedata:never-registered";
console.log(resolveObjectURL(id));
console.log(resolveObjectURL(""));
console.log(resolveObjectURL(id + ""));
console.log(resolveObjectURL(`blob:nodedata:${id.length}`) === undefined);

// The namespace read answers the same function.
console.log(bufferModule.resolveObjectURL(id) === undefined);

const saved: string = id.toUpperCase();
console.log(resolveObjectURL(saved));
console.log(resolveObjectURL(Buffer.from("blob").toString()) === undefined);

// A Blob is only reachable through a registered URL, which no compiled
// program can create; the value itself converts to its own text.
const blob = new Blob(["x"], { type: "text/plain" });
console.log(blob.size, blob.type);
