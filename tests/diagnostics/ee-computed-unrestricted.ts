import { PassThrough } from "node:stream";

const stream = new PassThrough();
const name = process.argv[2] ?? "topic";
stream.on(name, () => {});
