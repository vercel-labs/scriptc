// node:http2 hands a 'goaway' listener the frame's opaque data as a Buffer
// when the GOAWAY carries any and undefined when it does not, so a third
// parameter that cannot accept undefined would be handed undefined at
// runtime — the listener must accept it.
import * as http2 from "node:http2";

const client = http2.connect("http://127.0.0.1:1");
client.on("goaway", (code: number, lastStreamID: number, opaque: Uint8Array) => {
  void code;
  void lastStreamID;
  void opaque;
});
