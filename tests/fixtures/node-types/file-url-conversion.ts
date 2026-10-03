import { fileURLToPath, fileURLToPathBuffer, pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
const options = { windows: true };
const url = pathToFileURL("C:\\work\\a b#é.txt", options);
const path: string = fileURLToPath(url, options);
const bytes: Buffer = fileURLToPathBuffer(url, options);
console.log(url.href, path, Buffer.isBuffer(bytes), bytes.toString("hex"));
console.log(fileURLToPathBuffer("file:///C:/%FF%2F", options).toString("hex"));
