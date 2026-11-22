import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The webcrypto builtin call slots. */
export const webcryptoSignatures = defineLibFnSignatures({
  /** WebCrypto (scr_webcrypto.c): each method takes its argument vector as
   * one dyn array and answers a promise that argument and validation
   * failures reject. CryptoKey values are native handles. */
  "webcrypto.generateKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.importKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.exportKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.encrypt": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.decrypt": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.wrapKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.unwrapKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.deriveBits": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.deriveKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.getPublicKey": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.keyObjectToCryptoKey": { argTypes: [DYN], result: DYN },
  "webcrypto.keyObjectFrom": { argTypes: [DYN], result: DYN },
  "webcrypto.sign": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.verify": { argTypes: [DYN], result: { kind: "promise", inner: BOOL } },
  "webcrypto.digest": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "webcrypto.isCryptoKey": { argTypes: [DYN], result: BOOL },
  "webcrypto.object": { argTypes: [], result: DYN },
});
