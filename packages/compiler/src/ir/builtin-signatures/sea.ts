import { BOOL, DYN, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sea builtin call slots. */
export const seaSignatures = defineLibFnSignatures({
  /** node:sea in a program that is not a Node single-executable
   * application (every compiled program): isSea is false, and each asset
   * reader throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION once its
   * arguments are evaluated. Emitted in place; no runtime entry. */
  "sea.isSea": { argTypes: [], result: BOOL },
  "sea.getAsset": { argTypes: [STRING, STRING], result: DYN },
  "sea.getRawAsset": { argTypes: [STRING], result: DYN },
  "sea.getAssetAsBlob": { argTypes: [STRING, DYN], result: DYN },
  "sea.getAssetKeys": { argTypes: [], result: DYN },
});
