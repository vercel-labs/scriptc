// A 'goaway' listener's opaque data is the frame's bytes when the frame
// carries any and undefined otherwise — a wider union cannot be produced by
// the adapter, so it is refused at build time.
import * as http2 from "node:http2";

const client = http2.connect("http://127.0.0.1:1");
client.on(
  "goaway",
  (code: number, lastStreamID: number, opaque: Uint8Array | string | undefined) => {
    void code;
    void lastStreamID;
    void opaque;
  },
);
