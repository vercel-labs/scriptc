export declare const generateDigest: (stream: ReadableStream<Uint8Array> | null, generator: (body: Uint8Array) => ArrayBuffer | Promise<ArrayBuffer>) => Promise<string | null>;
