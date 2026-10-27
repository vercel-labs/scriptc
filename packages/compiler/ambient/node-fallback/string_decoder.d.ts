/* node:string_decoder — StringDecoder over Node's whole encoding set:
 * write() decodes complete sequences and buffers a trailing partial one
 * across chunk boundaries (utf8's truncated sequence, base64's mod-3
 * remainder, utf16le's odd byte / trailing lead surrogate; latin1, ascii
 * and hex are stateless); end() flushes the buffered partial. `encoding`
 * answers the normalized name. Node's exact algorithms (SEMANTICS.md);
 * the encoding must be a literal, and end(buffer) fences — write the
 * buffer, then end(). */
declare module "string_decoder" {
  export class StringDecoder {
    constructor(encoding?: BufferEncoding);
    readonly encoding: string;
    write(buffer: Uint8Array): string;
    end(buffer?: Uint8Array): string;
  }
}

declare module "node:string_decoder" {
  export * from "string_decoder";
}
