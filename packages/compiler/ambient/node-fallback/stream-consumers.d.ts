declare module "stream/consumers" {
  /* The promise consumers over a readable: accumulate every chunk and
   * settle — text (the utf8 decode), json (the text through JSON.parse:
   * `unknown`, validated with a checked cast; malformed input rejects
   * with the parse's SyntaxError), buffer (the concatenated bytes;
   * string chunks contribute their utf8 bytes, Node's Blob rule).
   * Stream errors reject; an early close rejects with
   * ERR_STREAM_PREMATURE_CLOSE. arrayBuffer answers an ArrayBuffer over
   * the bytes and bytes a Uint8Array of them; blob fences per site. */
  function text(stream: unknown): Promise<string>;
  function json(stream: unknown): Promise<unknown>;
  function buffer(stream: unknown): Promise<Buffer>;
  function arrayBuffer(stream: unknown): Promise<ArrayBuffer>;
  function bytes(stream: unknown): Promise<Uint8Array>;
  function blob(stream: unknown): Promise<unknown>;
  export { arrayBuffer, blob, buffer, bytes, json, text };
}

declare module "node:stream/consumers" {
  import streamConsumers = require("stream/consumers");
  export = streamConsumers;
}
