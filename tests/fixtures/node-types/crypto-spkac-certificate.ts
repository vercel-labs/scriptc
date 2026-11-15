// crypto.Certificate under @types/node: the class is callable with new (its
// instance carries no state), its statics take BinaryLike spkac text or bytes
// and answer Buffer, and verifySpkac takes the ArrayBufferView form the
// pinned declarations name. The buffers and booleans below are what Node 24
// answers for the same program.
import { Certificate } from "node:crypto";
import * as crypto from "node:crypto";

const SPKAC = "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE3RoaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xYLDTfujCM5FkSjRc4m6hnriEkc=";
const HIGH = "MIICUzCCATswggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC33FiIiiexwLe/P8DZx5HsqFlmUO7/lvJ7necJVNwqdZ3ax5jpQB0p6uxfqeOvzcN3k5V7UFb/Am+nkSNZMAZhsWzCU2Z4Pjh50QYz3f0Hour7/yIGStOLyYY3hgLK2K8TbhgjQPhdkw9+QtKlpvbL8fLgONAoGrVOFnRQGcr70iFffsm79mgZhKVMgYiHPJqJgGHvCtkGg9zMgS7p63+Q3ZWedtFS2RhMX3uCBy/mH6EOlRCNBbRmA4xxNzyf5GQaki3T+Iz9tOMjdPP+CwV2LqEdylmBuik8vrfTb3qIHLKKBAI8lXN26wWtA3kN4L7NP+cbKlCRlqctvhmylLH1AgMBAAEWE4BoaXMtaXMtYS1jaGFsbGVuZ2UwDQYJKoZIhvcNAQEEBQADggEBAIozmeW1kfDfAVwRQKileZGLRGCD7AjdHLYEe16xTBPve8Af1bDOyuWsAm4qQLYA4FAFROiKeGqxCtIErEvm87/09tCfF1My/1Uj+INjAk39DK9J9alLlTsrwSgd1lb3YlXY7TyitCmh7iXLo4pVhA2chNA3njiMq3CUpSvGbpzrESL2dv97lv590gUD988wkTDVyYsf0T8+X0Kww3AgPWGji+2f2i5/jTfD/s1lK1nqi7ZxFm0pGZoy1MJ51SCEy7Y82ajroI+5786nC02mo9ak7samca4YDZOoxN4d3tax4B/HDF5dqJSm1/31xYLDTfujCM5FkSjRc4m6hnriEkc=";

const challenge: Buffer = Certificate.exportChallenge(SPKAC);
const fromBytes: Buffer = Certificate.exportChallenge(Buffer.from(SPKAC));
const publicKey: Buffer = Certificate.exportPublicKey(SPKAC, "utf8");
const publicKeyBytes: Buffer = Certificate.exportPublicKey(new Uint8Array(Buffer.from(SPKAC)));
console.log("statics", challenge.toString(), challenge.equals(fromBytes), publicKey.equals(publicKeyBytes));
console.log("verify", Certificate.verifySpkac(Buffer.from(SPKAC)), Certificate.verifySpkac(new Uint8Array(Buffer.from(SPKAC))),
  Certificate.verifySpkac(Buffer.from(SPKAC, "base64")), Certificate.verifySpkac(Buffer.from("not*base64!")));
console.log("high", crypto.Certificate.exportChallenge(HIGH).toString("hex"), HIGH.length);
console.log("pem", publicKey.toString().split("\n")[0], publicKey.toString().length);

const certificate = new Certificate();
const instanceChallenge: Buffer = certificate.exportChallenge(SPKAC);
const instanceKey: Buffer = certificate.exportPublicKey(Buffer.from(SPKAC));
const instanceVerify: boolean = certificate.verifySpkac(Buffer.from(SPKAC));
console.log("instance", instanceChallenge.equals(challenge), instanceKey.equals(publicKey), instanceVerify,
  JSON.stringify(certificate), Object.keys(certificate).length);

const answers: [Buffer, Buffer, boolean] = [challenge, publicKey, instanceVerify];
console.log("tuple", answers[0].length, answers[1].length, answers[2]);
