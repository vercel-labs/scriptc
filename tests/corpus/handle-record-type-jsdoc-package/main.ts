// A JavaScript package whose function declares its parameter in JSDoc and
// in its declaration file as `{ isTTY?: boolean | undefined }`, called with
// a process stream held in a class field: the call passes the stream
// itself, and the package's own calls with `process.stdout` and
// `process.stderr` do too.
import type * as tty from "node:tty";
import { linkSupport } from "term-links";

class Output {
  stream: tty.WriteStream;
  links = false;
  constructor(stream: tty.WriteStream) {
    this.stream = stream;
    this.links = linkSupport(this.stream);
  }
}
console.log(new Output(process.stderr).links, new Output(process.stdout).links);
console.log(linkSupport(process.stdout), linkSupport({ isTTY: true }), linkSupport({}));
