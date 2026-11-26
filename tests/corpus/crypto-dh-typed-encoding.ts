// A statically typed encoding object in a callback generateKeyPair('dh'):
// the deferred export reads the encoding the call was made with, so the
// private key comes back in that encoding (a typed reference holds its
// fields outside the object the options graph carries).
import * as crypto from "node:crypto";

interface Encoding {
  type: "pkcs8";
  format: "pem";
}
const encoding: Encoding = { type: "pkcs8", format: "pem" };
const options = { group: "modp5", privateKeyEncoding: encoding } as any;
const result = await new Promise<string>((resolve) => {
  crypto.generateKeyPair(
    "dh" as any,
    options,
    ((error: Error | null, publicKey: { asymmetricKeyType?: string }, privateKey: string) =>
      resolve(
        error
          ? `${error.name}: ${error.message}`
          : `${publicKey.asymmetricKeyType} ${typeof privateKey} ${String(privateKey).split("\n")[0]}`,
      )) as any,
  );
});
console.log("typed encoding", result);
