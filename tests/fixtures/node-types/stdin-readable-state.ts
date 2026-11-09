// pause() and resume() through process.stdin and through the Readable it
// is handed on as act on one stream: each name reports what the other did.
// Nothing reads the input and it ends paused, so the program exits while
// its input is still open.
import type { Readable } from "node:stream";

function probe(stream: Readable): void {
  const show = (label: string): void => {
    console.log(label, stream.isPaused(), stream.readableFlowing, process.stdin.isPaused());
  };
  show("start");
  stream.pause();
  show("stream.pause");
  process.stdin.resume();
  show("stdin.resume");
  process.stdin.pause();
  show("stdin.pause");
  stream.resume();
  show("stream.resume");
  stream.pause();
  show("end");
}

probe(process.stdin);
