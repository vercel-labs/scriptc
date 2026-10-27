// getCipherInfo, AES-CCM and AES key wrap through their declared types: the
// CipherInfo record's fields, absent fields and key order, the keyLength and
// ivLength options, and the CipherCCM and DecipherCCM members.
import { createCipheriv, createDecipheriv, getCipherInfo, type CipherInfo } from "node:crypto";

const info: CipherInfo | undefined = getCipherInfo("aes-128-ccm");
if (info) console.log(info.name, info.nid, info.mode, info.keyLength, info.ivLength, info.blockSize);
const byNid = getCipherInfo(901);
console.log(byNid?.name, byNid?.mode);
const sized = getCipherInfo("aes-128-ccm", { ivLength: 7 });
console.log(sized?.ivLength, getCipherInfo("aes-128-ccm", { ivLength: 6 }));
console.log(getCipherInfo("nope"));
console.log(JSON.stringify(getCipherInfo("AES-256-WRAP-PAD")!));
console.log(Object.keys(getCipherInfo("chacha20")!), JSON.stringify(getCipherInfo("aes-128-ecb")!));
for (const name of ["rc4", "des-ede3-cbc", "aes-256-xts", "chacha20-poly1305"]) {
  const found = getCipherInfo(name, { keyLength: 32 });
  console.log(name, found ? Object.keys(found).join() : "none", found?.blockSize, found?.ivLength);
}

const key = Buffer.alloc(16, 1);
const iv = Buffer.alloc(12, 2);
const aad = Buffer.from("header");
const plain = Buffer.from("typed ccm message");
const cipher = createCipheriv("aes-128-ccm", key, iv, { authTagLength: 8 });
cipher.setAAD(aad, { plaintextLength: plain.length });
const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
const tag: Buffer = cipher.getAuthTag();
console.log(ciphertext.toString("hex"), tag.toString("hex"));
const decipher = createDecipheriv("aes-128-ccm", key, iv, { authTagLength: 8 });
decipher.setAuthTag(tag);
decipher.setAAD(aad, { plaintextLength: ciphertext.length });
const opened: Buffer = decipher.update(ciphertext);
decipher.final();
console.log(opened.toString());

const kek = Buffer.alloc(24, 3);
const icv = Buffer.from("A6A6A6A6A6A6A6A6", "hex");
const wrap = createCipheriv("aes192-wrap", kek, icv);
const wrapped = Buffer.concat([wrap.update(Buffer.alloc(16, 9)), wrap.final()]);
console.log(wrapped.toString("base64"));
const unwrap = createDecipheriv("id-aes192-wrap", kek, icv);
console.log(Buffer.concat([unwrap.update(wrapped), unwrap.final()]).toString("hex"));
