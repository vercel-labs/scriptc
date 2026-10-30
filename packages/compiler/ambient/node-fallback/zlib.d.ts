/// <reference path="./stream.d.ts" />

/* node:zlib — the one-shot zlib/raw/gzip codecs lower for string/Buffer
 * inputs with Node's default options; libz links only into zlib-using
 * binaries. Callback forms use the executable worker pool. Options stay
 * declared so reached uses receive a named SC2020 refusal. The Deflate,
 * Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip, BrotliCompress
 * and BrotliDecompress streams are runtime Transform streams; Zstd remains
 * outside the lowered surface. */
declare module "zlib" {
  import { Transform } from "stream";
  export interface ZlibOptions {
    [option: string]: unknown;
  }
  export type ZlibCallback = (error: NodeJS.ErrnoException | null, result: Buffer) => void;
  export function deflate(data: string | Uint8Array, callback: ZlibCallback): void;
  export function deflate(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function deflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function inflate(data: string | Uint8Array, callback: ZlibCallback): void;
  export function inflate(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function inflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function deflateRaw(data: string | Uint8Array, callback: ZlibCallback): void;
  export function deflateRaw(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function deflateRawSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function inflateRaw(data: string | Uint8Array, callback: ZlibCallback): void;
  export function inflateRaw(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function inflateRawSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function gzip(data: string | Uint8Array, callback: ZlibCallback): void;
  export function gzip(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function gzipSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function gunzip(data: string | Uint8Array, callback: ZlibCallback): void;
  export function gunzip(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function gunzipSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function unzip(data: string | Uint8Array, callback: ZlibCallback): void;
  export function unzip(
    data: string | Uint8Array,
    options: ZlibOptions,
    callback: ZlibCallback,
  ): void;
  export function unzipSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function crc32(data: string | Uint8Array, value?: number): number;
  /* Brotli over the vendored brotli 1.2.0 (scr_brotli.c): `params` keys
   * are the numeric BROTLI_PARAM_* and BROTLI_DECODER_PARAM_* constants. */
  export interface BrotliOptions {
    [option: string]: unknown;
  }
  export function brotliCompress(data: string | Uint8Array, callback: ZlibCallback): void;
  export function brotliCompress(
    data: string | Uint8Array,
    options: BrotliOptions,
    callback: ZlibCallback,
  ): void;
  export function brotliCompressSync(data: string | Uint8Array, options?: BrotliOptions): Buffer;
  export function brotliDecompress(data: string | Uint8Array, callback: ZlibCallback): void;
  export function brotliDecompress(
    data: string | Uint8Array,
    options: BrotliOptions,
    callback: ZlibCallback,
  ): void;
  export function brotliDecompressSync(data: string | Uint8Array, options?: BrotliOptions): Buffer;
  /* The stream classes: runtime Transform streams over the zlib engine
   * (scr_zlib_stream.c). createGzip(options) and new Gzip(options) build
   * the same stream; options are validated at runtime with Node's rules.
   * Brotli streams have no params(), as in Node. */
  class ZlibBase extends Transform {
    readonly bytesWritten: number;
    flush(kind?: number, callback?: () => void): void;
    flush(callback: () => void): void;
    close(callback?: () => void): void;
    reset(): void;
  }
  class Zlib extends ZlibBase {
    params(level: number, strategy: number, callback?: () => void): void;
  }
  export class BrotliCompress extends ZlibBase {
    constructor(options?: BrotliOptions);
  }
  export class BrotliDecompress extends ZlibBase {
    constructor(options?: BrotliOptions);
  }
  export function createBrotliCompress(options?: BrotliOptions): BrotliCompress;
  export function createBrotliDecompress(options?: BrotliOptions): BrotliDecompress;
  export class Deflate extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export class Inflate extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export class Gzip extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export class Gunzip extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export class DeflateRaw extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export class InflateRaw extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export class Unzip extends Zlib {
    constructor(options?: ZlibOptions);
  }
  export function createDeflate(options?: ZlibOptions): Deflate;
  export function createInflate(options?: ZlibOptions): Inflate;
  export function createGzip(options?: ZlibOptions): Gzip;
  export function createGunzip(options?: ZlibOptions): Gunzip;
  export function createDeflateRaw(options?: ZlibOptions): DeflateRaw;
  export function createInflateRaw(options?: ZlibOptions): InflateRaw;
  export function createUnzip(options?: ZlibOptions): Unzip;
  /* Node v24 zlib.constants, literal-typed (the CryptoConstants stance):
   * every access bakes as its literal; the object never materializes. The
   * members outside BROTLI_* are also module properties (zlib.Z_SYNC_FLUSH). */
  export interface ZlibConstants {
    readonly Z_NO_FLUSH: 0;
    readonly Z_PARTIAL_FLUSH: 1;
    readonly Z_SYNC_FLUSH: 2;
    readonly Z_FULL_FLUSH: 3;
    readonly Z_FINISH: 4;
    readonly Z_BLOCK: 5;
    readonly Z_OK: 0;
    readonly Z_STREAM_END: 1;
    readonly Z_NEED_DICT: 2;
    readonly Z_ERRNO: -1;
    readonly Z_STREAM_ERROR: -2;
    readonly Z_DATA_ERROR: -3;
    readonly Z_MEM_ERROR: -4;
    readonly Z_BUF_ERROR: -5;
    readonly Z_VERSION_ERROR: -6;
    readonly Z_NO_COMPRESSION: 0;
    readonly Z_BEST_SPEED: 1;
    readonly Z_BEST_COMPRESSION: 9;
    readonly Z_DEFAULT_COMPRESSION: -1;
    readonly Z_FILTERED: 1;
    readonly Z_HUFFMAN_ONLY: 2;
    readonly Z_RLE: 3;
    readonly Z_FIXED: 4;
    readonly Z_DEFAULT_STRATEGY: 0;
    readonly ZLIB_VERNUM: 4897;
    readonly DEFLATE: 1;
    readonly INFLATE: 2;
    readonly GZIP: 3;
    readonly GUNZIP: 4;
    readonly DEFLATERAW: 5;
    readonly INFLATERAW: 6;
    readonly UNZIP: 7;
    readonly BROTLI_DECODE: 8;
    readonly BROTLI_ENCODE: 9;
    readonly ZSTD_DECOMPRESS: 11;
    readonly ZSTD_COMPRESS: 10;
    readonly Z_MIN_WINDOWBITS: 8;
    readonly Z_MAX_WINDOWBITS: 15;
    readonly Z_DEFAULT_WINDOWBITS: 15;
    readonly Z_MIN_CHUNK: 64;
    readonly Z_MAX_CHUNK: number;
    readonly Z_DEFAULT_CHUNK: 16384;
    readonly Z_MIN_MEMLEVEL: 1;
    readonly Z_MAX_MEMLEVEL: 9;
    readonly Z_DEFAULT_MEMLEVEL: 8;
    readonly Z_MIN_LEVEL: -1;
    readonly Z_MAX_LEVEL: 9;
    readonly Z_DEFAULT_LEVEL: -1;
    readonly BROTLI_OPERATION_PROCESS: 0;
    readonly BROTLI_OPERATION_FLUSH: 1;
    readonly BROTLI_OPERATION_FINISH: 2;
    readonly BROTLI_OPERATION_EMIT_METADATA: 3;
    readonly BROTLI_PARAM_MODE: 0;
    readonly BROTLI_MODE_GENERIC: 0;
    readonly BROTLI_MODE_TEXT: 1;
    readonly BROTLI_MODE_FONT: 2;
    readonly BROTLI_DEFAULT_MODE: 0;
    readonly BROTLI_PARAM_QUALITY: 1;
    readonly BROTLI_MIN_QUALITY: 0;
    readonly BROTLI_MAX_QUALITY: 11;
    readonly BROTLI_DEFAULT_QUALITY: 11;
    readonly BROTLI_PARAM_LGWIN: 2;
    readonly BROTLI_MIN_WINDOW_BITS: 10;
    readonly BROTLI_MAX_WINDOW_BITS: 24;
    readonly BROTLI_LARGE_MAX_WINDOW_BITS: 30;
    readonly BROTLI_DEFAULT_WINDOW: 22;
    readonly BROTLI_PARAM_LGBLOCK: 3;
    readonly BROTLI_MIN_INPUT_BLOCK_BITS: 16;
    readonly BROTLI_MAX_INPUT_BLOCK_BITS: 24;
    readonly BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4;
    readonly BROTLI_PARAM_SIZE_HINT: 5;
    readonly BROTLI_PARAM_LARGE_WINDOW: 6;
    readonly BROTLI_PARAM_NPOSTFIX: 7;
    readonly BROTLI_PARAM_NDIRECT: 8;
    readonly BROTLI_DECODER_RESULT_ERROR: 0;
    readonly BROTLI_DECODER_RESULT_SUCCESS: 1;
    readonly BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2;
    readonly BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3;
    readonly BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0;
    readonly BROTLI_DECODER_PARAM_LARGE_WINDOW: 1;
    readonly BROTLI_DECODER_NO_ERROR: 0;
    readonly BROTLI_DECODER_SUCCESS: 1;
    readonly BROTLI_DECODER_NEEDS_MORE_INPUT: 2;
    readonly BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3;
    readonly BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1;
    readonly BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2;
    readonly BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3;
    readonly BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4;
    readonly BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5;
    readonly BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6;
    readonly BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7;
    readonly BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8;
    readonly BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9;
    readonly BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10;
    readonly BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11;
    readonly BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12;
    readonly BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13;
    readonly BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14;
    readonly BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15;
    readonly BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16;
    readonly BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19;
    readonly BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20;
    readonly BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21;
    readonly BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22;
    readonly BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25;
    readonly BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26;
    readonly BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27;
    readonly BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30;
    readonly BROTLI_DECODER_ERROR_UNREACHABLE: -31;
    readonly ZSTD_e_continue: 0;
    readonly ZSTD_e_flush: 1;
    readonly ZSTD_e_end: 2;
    readonly ZSTD_fast: 1;
    readonly ZSTD_dfast: 2;
    readonly ZSTD_greedy: 3;
    readonly ZSTD_lazy: 4;
    readonly ZSTD_lazy2: 5;
    readonly ZSTD_btlazy2: 6;
    readonly ZSTD_btopt: 7;
    readonly ZSTD_btultra: 8;
    readonly ZSTD_btultra2: 9;
    readonly ZSTD_c_compressionLevel: 100;
    readonly ZSTD_c_windowLog: 101;
    readonly ZSTD_c_hashLog: 102;
    readonly ZSTD_c_chainLog: 103;
    readonly ZSTD_c_searchLog: 104;
    readonly ZSTD_c_minMatch: 105;
    readonly ZSTD_c_targetLength: 106;
    readonly ZSTD_c_strategy: 107;
    readonly ZSTD_c_enableLongDistanceMatching: 160;
    readonly ZSTD_c_ldmHashLog: 161;
    readonly ZSTD_c_ldmMinMatch: 162;
    readonly ZSTD_c_ldmBucketSizeLog: 163;
    readonly ZSTD_c_ldmHashRateLog: 164;
    readonly ZSTD_c_contentSizeFlag: 200;
    readonly ZSTD_c_checksumFlag: 201;
    readonly ZSTD_c_dictIDFlag: 202;
    readonly ZSTD_c_nbWorkers: 400;
    readonly ZSTD_c_jobSize: 401;
    readonly ZSTD_c_overlapLog: 402;
    readonly ZSTD_d_windowLogMax: 100;
    readonly ZSTD_CLEVEL_DEFAULT: 3;
    readonly ZSTD_error_no_error: 0;
    readonly ZSTD_error_GENERIC: 1;
    readonly ZSTD_error_prefix_unknown: 10;
    readonly ZSTD_error_version_unsupported: 12;
    readonly ZSTD_error_frameParameter_unsupported: 14;
    readonly ZSTD_error_frameParameter_windowTooLarge: 16;
    readonly ZSTD_error_corruption_detected: 20;
    readonly ZSTD_error_checksum_wrong: 22;
    readonly ZSTD_error_literals_headerWrong: 24;
    readonly ZSTD_error_dictionary_corrupted: 30;
    readonly ZSTD_error_dictionary_wrong: 32;
    readonly ZSTD_error_dictionaryCreation_failed: 34;
    readonly ZSTD_error_parameter_unsupported: 40;
    readonly ZSTD_error_parameter_combination_unsupported: 41;
    readonly ZSTD_error_parameter_outOfBound: 42;
    readonly ZSTD_error_tableLog_tooLarge: 44;
    readonly ZSTD_error_maxSymbolValue_tooLarge: 46;
    readonly ZSTD_error_maxSymbolValue_tooSmall: 48;
    readonly ZSTD_error_stabilityCondition_notRespected: 50;
    readonly ZSTD_error_stage_wrong: 60;
    readonly ZSTD_error_init_missing: 62;
    readonly ZSTD_error_memory_allocation: 64;
    readonly ZSTD_error_workSpace_tooSmall: 66;
    readonly ZSTD_error_dstSize_tooSmall: 70;
    readonly ZSTD_error_srcSize_wrong: 72;
    readonly ZSTD_error_dstBuffer_null: 74;
    readonly ZSTD_error_noForwardProgress_destFull: 80;
    readonly ZSTD_error_noForwardProgress_inputEmpty: 82;
  }
  export const constants: ZlibConstants;
  export const Z_NO_FLUSH: 0;
  export const Z_PARTIAL_FLUSH: 1;
  export const Z_SYNC_FLUSH: 2;
  export const Z_FULL_FLUSH: 3;
  export const Z_FINISH: 4;
  export const Z_BLOCK: 5;
  export const Z_OK: 0;
  export const Z_STREAM_END: 1;
  export const Z_NEED_DICT: 2;
  export const Z_ERRNO: -1;
  export const Z_STREAM_ERROR: -2;
  export const Z_DATA_ERROR: -3;
  export const Z_MEM_ERROR: -4;
  export const Z_BUF_ERROR: -5;
  export const Z_VERSION_ERROR: -6;
  export const Z_NO_COMPRESSION: 0;
  export const Z_BEST_SPEED: 1;
  export const Z_BEST_COMPRESSION: 9;
  export const Z_DEFAULT_COMPRESSION: -1;
  export const Z_FILTERED: 1;
  export const Z_HUFFMAN_ONLY: 2;
  export const Z_RLE: 3;
  export const Z_FIXED: 4;
  export const Z_DEFAULT_STRATEGY: 0;
  export const ZLIB_VERNUM: 4897;
  export const DEFLATE: 1;
  export const INFLATE: 2;
  export const GZIP: 3;
  export const GUNZIP: 4;
  export const DEFLATERAW: 5;
  export const INFLATERAW: 6;
  export const UNZIP: 7;
  export const ZSTD_DECOMPRESS: 11;
  export const ZSTD_COMPRESS: 10;
  export const Z_MIN_WINDOWBITS: 8;
  export const Z_MAX_WINDOWBITS: 15;
  export const Z_DEFAULT_WINDOWBITS: 15;
  export const Z_MIN_CHUNK: 64;
  export const Z_MAX_CHUNK: number;
  export const Z_DEFAULT_CHUNK: 16384;
  export const Z_MIN_MEMLEVEL: 1;
  export const Z_MAX_MEMLEVEL: 9;
  export const Z_DEFAULT_MEMLEVEL: 8;
  export const Z_MIN_LEVEL: -1;
  export const Z_MAX_LEVEL: 9;
  export const Z_DEFAULT_LEVEL: -1;
  export const ZSTD_e_continue: 0;
  export const ZSTD_e_flush: 1;
  export const ZSTD_e_end: 2;
  export const ZSTD_fast: 1;
  export const ZSTD_dfast: 2;
  export const ZSTD_greedy: 3;
  export const ZSTD_lazy: 4;
  export const ZSTD_lazy2: 5;
  export const ZSTD_btlazy2: 6;
  export const ZSTD_btopt: 7;
  export const ZSTD_btultra: 8;
  export const ZSTD_btultra2: 9;
  export const ZSTD_c_compressionLevel: 100;
  export const ZSTD_c_windowLog: 101;
  export const ZSTD_c_hashLog: 102;
  export const ZSTD_c_chainLog: 103;
  export const ZSTD_c_searchLog: 104;
  export const ZSTD_c_minMatch: 105;
  export const ZSTD_c_targetLength: 106;
  export const ZSTD_c_strategy: 107;
  export const ZSTD_c_enableLongDistanceMatching: 160;
  export const ZSTD_c_ldmHashLog: 161;
  export const ZSTD_c_ldmMinMatch: 162;
  export const ZSTD_c_ldmBucketSizeLog: 163;
  export const ZSTD_c_ldmHashRateLog: 164;
  export const ZSTD_c_contentSizeFlag: 200;
  export const ZSTD_c_checksumFlag: 201;
  export const ZSTD_c_dictIDFlag: 202;
  export const ZSTD_c_nbWorkers: 400;
  export const ZSTD_c_jobSize: 401;
  export const ZSTD_c_overlapLog: 402;
  export const ZSTD_d_windowLogMax: 100;
  export const ZSTD_CLEVEL_DEFAULT: 3;
  export const ZSTD_error_no_error: 0;
  export const ZSTD_error_GENERIC: 1;
  export const ZSTD_error_prefix_unknown: 10;
  export const ZSTD_error_version_unsupported: 12;
  export const ZSTD_error_frameParameter_unsupported: 14;
  export const ZSTD_error_frameParameter_windowTooLarge: 16;
  export const ZSTD_error_corruption_detected: 20;
  export const ZSTD_error_checksum_wrong: 22;
  export const ZSTD_error_literals_headerWrong: 24;
  export const ZSTD_error_dictionary_corrupted: 30;
  export const ZSTD_error_dictionary_wrong: 32;
  export const ZSTD_error_dictionaryCreation_failed: 34;
  export const ZSTD_error_parameter_unsupported: 40;
  export const ZSTD_error_parameter_combination_unsupported: 41;
  export const ZSTD_error_parameter_outOfBound: 42;
  export const ZSTD_error_tableLog_tooLarge: 44;
  export const ZSTD_error_maxSymbolValue_tooLarge: 46;
  export const ZSTD_error_maxSymbolValue_tooSmall: 48;
  export const ZSTD_error_stabilityCondition_notRespected: 50;
  export const ZSTD_error_stage_wrong: 60;
  export const ZSTD_error_init_missing: 62;
  export const ZSTD_error_memory_allocation: 64;
  export const ZSTD_error_workSpace_tooSmall: 66;
  export const ZSTD_error_dstSize_tooSmall: 70;
  export const ZSTD_error_srcSize_wrong: 72;
  export const ZSTD_error_dstBuffer_null: 74;
  export const ZSTD_error_noForwardProgress_destFull: 80;
  export const ZSTD_error_noForwardProgress_inputEmpty: 82;
}

declare module "node:zlib" {
  export * from "zlib";
}
