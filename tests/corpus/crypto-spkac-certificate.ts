// crypto.Certificate and the SPKAC methods match Node: the base64 text a
// Netscape spkac file holds (a string, or the bytes of a Buffer, typed
// array, DataView or ArrayBuffer, read through the optional encoding), the
// leading space and tab trim and trailing whitespace and dash strip before
// decoding, verifySpkac's boolean, exportChallenge's return as UTF-8 (an
// IA5 byte past 0x7F takes two bytes), exportPublicKey's PEM, the empty
// answers for text no spkac decoder accepts, the argument and encoding
// errors, and the empty instance the statics and deprecated instance
// methods share.
import * as crypto from "node:crypto";
import { Certificate } from "node:crypto";

// A 2048-bit RSA spkac signing md5WithRSA, its challenge "this-is-a-challenge".
const SPKAC = "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE3RoaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xYLDTfujCM5FkSjRc4m6hnriEkc=";
// The same spkac with challenge byte 0x80 and 0xFF.
const HIGH = "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE4BoaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xYLDTfujCM5FkSjRc4m6hnriEkc=";
const HIGH2 = "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE/9BaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xYLDTfujCM5FkSjRc4m6hnriEkc=";
// The same spkac with one signature character changed.
const SIGFLIP = "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE3RoaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xZLDTfujCM5FkSjRc4m6hnriEkc=";
const CHALLENGE = "this-is-a-challenge";

const hex = (b: Buffer) => `${b.length} ${b.toString("hex")}`;
const show = (label: string, fn: () => unknown) => {
  try {
    console.log(label, fn());
  } catch (e) {
    const err = e as { code?: string; message: string };
    console.log(label, err.code, err.message);
  }
};

console.log("verify", Certificate.verifySpkac(SPKAC), Certificate.verifySpkac(Buffer.from(SPKAC)));
console.log("verify views", Certificate.verifySpkac(new Uint8Array(Buffer.from(SPKAC))),
  Certificate.verifySpkac(new DataView(new Uint8Array(Buffer.from(SPKAC)).buffer)),
  Certificate.verifySpkac(new Uint8Array(Buffer.from(SPKAC)).buffer));
console.log("verify tampered", Certificate.verifySpkac(SIGFLIP));
console.log("verify der", Certificate.verifySpkac(Buffer.from(SPKAC, "base64")));
console.log("verify pem", Certificate.verifySpkac(`-----BEGIN SPKAC-----\n${SPKAC}\n-----END SPKAC-----\n`));
console.log("verify garbage", Certificate.verifySpkac("not*base64!"), Certificate.verifySpkac(SPKAC.slice(0, 400)));
console.log("verify whitespace", Certificate.verifySpkac(" \t" + SPKAC), Certificate.verifySpkac(SPKAC + "---\r\n\t "),
  Certificate.verifySpkac("\n" + SPKAC), Certificate.verifySpkac(SPKAC.slice(0, 64) + "\n" + SPKAC.slice(64)));

const challenge = Certificate.exportChallenge(SPKAC);
console.log("challenge", JSON.stringify(challenge.toString()), challenge.toString("hex"), challenge.equals(Buffer.from(CHALLENGE)));
console.log("challenge buffer", hex(Certificate.exportChallenge(Buffer.from(SPKAC))),
  hex(Certificate.exportChallenge(new Uint8Array(Buffer.from(SPKAC)))));
console.log("challenge high", hex(Certificate.exportChallenge(HIGH)), JSON.stringify(Certificate.exportChallenge(HIGH).toString()));
console.log("challenge high2", hex(Certificate.exportChallenge(HIGH2)), JSON.stringify(Certificate.exportChallenge(HIGH2).toString()));
console.log("challenge invalid", hex(Certificate.exportChallenge("not*base64!")), hex(Certificate.exportChallenge(Buffer.from(SPKAC, "base64"))));

const pem = Certificate.exportPublicKey(SPKAC);
console.log("public key", pem.length, pem.equals(Certificate.exportPublicKey(Buffer.from(SPKAC))));
console.log(pem.toString());
console.log("public key invalid", JSON.stringify(Certificate.exportPublicKey("nope").toString()),
  JSON.stringify(Certificate.exportPublicKey(Buffer.from(SPKAC, "base64")).toString()));

const cert = new Certificate();
console.log("instance", cert.verifySpkac(SPKAC), cert.verifySpkac(SIGFLIP) === Certificate.verifySpkac(SIGFLIP));
console.log("instance challenge", hex(cert.exportChallenge(SPKAC)), cert.exportPublicKey(SPKAC).equals(pem));
console.log("instance shape", JSON.stringify(Object.keys(cert)), JSON.stringify({ ...cert }), JSON.stringify(cert), typeof cert);

show("verify number", () => Certificate.verifySpkac(7 as any));
show("verify undefined", () => Certificate.verifySpkac(undefined as any));
show("verify null", () => Certificate.verifySpkac(null as any));
show("verify object", () => Certificate.verifySpkac({} as any));
show("bogus encoding", () => Certificate.exportPublicKey(SPKAC, "bogus"));
console.log("utf8 encoding", Certificate.exportPublicKey(SPKAC, "utf8").equals(pem));
console.log("buffer encoding", Certificate.exportPublicKey(Buffer.from(SPKAC), "bogus").equals(pem),
  Certificate.exportPublicKey(Buffer.from(SPKAC), "base64").equals(pem));
console.log("numeric encoding", Certificate.exportPublicKey(SPKAC, 5 as any).equals(pem));
console.log("base64 encoding", Certificate.exportPublicKey(SPKAC, "base64").length,
  hex(Certificate.exportPublicKey(SPKAC, "base64")));
