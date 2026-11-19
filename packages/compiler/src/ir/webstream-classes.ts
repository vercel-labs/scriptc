/* The web stream classes in scr_webstreams.c's scr_webstream_class order: a
 * class's index is its WebSTREAM_INDEX value (webstream.class), the kind
 * webstream.instanceOf answers, and the class whose prototype and accessors
 * a handle tag names. The ordering is the runtime's, so it lives here where
 * both the lowering and the runtime feature rules can read it. */
export const WEB_STREAM_CLASSES = [
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamDefaultController",
  "CountQueuingStrategy",
  "ByteLengthQueuingStrategy",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "WritableStreamDefaultController",
  "TransformStream",
  "TransformStreamDefaultController",
  "TextEncoderStream",
  "TextDecoderStream",
  "ReadableByteStreamController",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "CompressionStream",
  "DecompressionStream",
] as const;

/** TextDecoderStream's index: its transform decodes through scr_bytes.c's
 * streaming decoder, whose non-UTF-8 half is the legacy runtime build. */
export const TEXT_DECODER_STREAM_CLASS = WEB_STREAM_CLASSES.indexOf("TextDecoderStream");

/** CompressionStream's index: constructing it (or DecompressionStream, one
 * past it) selects the zlib unit its transform runs on. */
export const COMPRESSION_STREAM_CLASS = WEB_STREAM_CLASSES.indexOf("CompressionStream");
export const DECOMPRESSION_STREAM_CLASS = WEB_STREAM_CLASSES.indexOf("DecompressionStream");
