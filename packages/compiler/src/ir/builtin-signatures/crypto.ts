import { BOOL, BYTES_U8, CRYPTOHASH_T, CRYPTOHMAC_T, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The crypto builtin call slots. */
export const cryptoSignatures = defineLibFnSignatures({
  /** The composed `new crypto.X509Certificate(data).fingerprint` read
   * (scr_lib.c — no certificate handle exists): the SHA-1 of the DER,
   * uppercase colon-separated, over PEM or raw-DER Buffer input; other
   * inputs throw Node's ERR_OSSL_PEM_NO_START_LINE Error (may-throw). */
  "crypto.x509Fingerprint": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509FingerprintStr": { argTypes: [STRING], result: STRING },
  /** The certificate's Validity window (validFrom / validTo reads —
   * scr_lib.c's minimal ASN.1 walk to the TBSCertificate validity
   * SEQUENCE): UTCTime and GeneralizedTime render in Node's exact
   * ASN1_TIME_print shape ("Jul  1 00:00:00 2026 GMT" — %2d space-padded
   * day). Same input contract and PEM error as the fingerprint pair
   * (may-throw). */
  "crypto.x509ValidFrom": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509ValidFromStr": { argTypes: [STRING], result: STRING },
  "crypto.x509ValidTo": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509ValidToStr": { argTypes: [STRING], result: STRING },
  /** The certificate's DER as a fresh Buffer (the raw field), decoded
   * once from the constructor's input; the same PEM error (may-throw). */
  "crypto.x509Raw": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "crypto.x509RawDer": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "crypto.x509RawStr": { argTypes: [STRING], result: BYTES_U8 },
  /** The constructor's input when its type is not known statically
   * (`unknown`, `any`, a primitive or a union): a PEM/DER Buffer or a
   * PEM string decodes as the static forms do, and every other value
   * throws Node's ERR_INVALID_ARG_TYPE TypeError for "buffer" (may-throw). */
  "crypto.x509RawDyn": { argTypes: [DYN], result: BYTES_U8 },
  /** The certificate's dynamic handle for a record's DER: the record
   * crossing into a dynamic slot, with Node's prototype fields and
   * methods, no own keys, and its PEM as JSON. */
  "crypto.x509Dyn": { argTypes: [BYTES_U8], result: DYN },
  /** `value instanceof crypto.X509Certificate` for a dynamic value: true
   * for a certificate handle. */
  "crypto.x509IsDyn": { argTypes: [DYN], result: BOOL },
  /** The remaining X509Certificate fields over that DER, in Node's
   * renderings (scr_lib.c). subjectAltName, infoAccess and
   * signatureAlgorithm answer "" where Node answers undefined. Borrowed;
   * never throw. */
  "crypto.x509Subject": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509Issuer": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509SubjectAltName": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509InfoAccess": { argTypes: [BYTES_U8], result: STRING },
  /** keyUsage: the extended key usage OIDs as a dynamic array, or
   * undefined when the extension is absent. */
  "crypto.x509KeyUsage": { argTypes: [BYTES_U8], result: DYN },
  "crypto.x509SerialNumber": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509Fingerprint256": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509Fingerprint512": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509Ca": { argTypes: [BYTES_U8], result: BOOL },
  "crypto.x509SignatureAlgorithm": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509SignatureAlgorithmOid": { argTypes: [BYTES_U8], result: STRING },
  /** X509Certificate methods over its raw DER. checkHost/checkEmail/checkIP
   * answer the matching name or "" (undefined), checkIssued compares two
   * certificates, x509Pem is toString's PEM (scr_x509.c); publicKey,
   * verify and checkPrivateKey read keys (scr_pki.c). */
  "crypto.x509CheckHost": { argTypes: [BYTES_U8, DYN, DYN], result: STRING },
  "crypto.x509CheckEmail": { argTypes: [BYTES_U8, DYN, DYN], result: STRING },
  "crypto.x509CheckIP": { argTypes: [BYTES_U8, DYN, DYN], result: STRING },
  "crypto.x509CheckIssued": { argTypes: [BYTES_U8, BYTES_U8], result: BOOL },
  "crypto.x509LegacyObject": { argTypes: [BYTES_U8], result: DYN },
  "crypto.x509Pem": { argTypes: [BYTES_U8], result: STRING },
  "crypto.x509PublicKey": { argTypes: [BYTES_U8], result: DYN },
  "crypto.x509Verify": { argTypes: [BYTES_U8, DYN], result: BOOL },
  "crypto.x509CheckPrivateKey": { argTypes: [BYTES_U8, DYN], result: BOOL },
  /** crypto.Certificate's SPKAC methods (scr_pki.c), over the spkac
   * argument and its optional encoding: the base64 text decodes as
   * NETSCAPE_SPKI_b64_decode does (EVP_DecodeBlock, then d2i), and a
   * string decodes as Buffer.from does. verifySpkac checks the signature
   * against the key the SPKAC itself carries; exportChallenge copies the
   * challenge, exportPublicKey writes the key's PEM. Input no decoder
   * accepts answers false or an empty Buffer (Node answers an empty
   * string). */
  "crypto.spkacVerify": { argTypes: [DYN, DYN], result: BOOL },
  "crypto.spkacChallenge": { argTypes: [DYN, DYN], result: BYTES_U8 },
  "crypto.spkacPublicKey": { argTypes: [DYN, DYN], result: BYTES_U8 },
  /** fs/promises (scr_lib.c over scr_async.c's settled minting): the SAME
   * sync syscalls, wrapped in an ALREADY-SETTLED promise — failure
   * REJECTS (catchable at the await) instead of throwing, so none of
   * these are in the may-throw seed. readFile is utf8-fenced like
   * readFileSync. The non-interleaving divergence is documented in
   * SEMANTICS.md. */
  /** node:crypto randomness: randomUUID plus randomBytes as either a real
   * Buffer or the fused randomBytes(n).toString("hex"|"base64") path.
   * The size-taking forms throw Node's RangeError on invalid values. */
  "crypto.randomUUID": { argTypes: [], result: STRING },
  "crypto.randomBytesToString": { argTypes: [F64, STRING], result: STRING },
  /** crypto.randomBytes(n) → a real u8 Buffer (+1). THROWS Node's
   * RangeError on out-of-range sizes, exactly like the composed
   * randomBytesToString (which keeps its one-libCall lowering — the two
   * coexist: the composed form never materializes the Buffer). */
  "crypto.randomBytes": { argTypes: [F64], result: BYTES_U8 },
  /** The fused createHash(alg).update(data).digest(enc) fast path and the
   * one-shot crypto.hash implementation. First-class Hash/Hmac handles use
   * the entries below; all paths share the incremental runtime core. */
  "crypto.hashDigestStr": { argTypes: [STRING, STRING, STRING], result: STRING },
  "crypto.hashDigestBytes": { argTypes: [STRING, BYTES_U8, STRING], result: STRING },
  /** First-class static Hash/Hmac handles. Constructors validate the
   * runtime algorithm string (every digest Node 24 lists); update returns the same
   * handle by retained identity, copy snapshots Hash state, and digest
   * finalizes the handle and returns either a Buffer or encoded string. */
  "crypto.native": { argTypes: [], result: DYN },
  "crypto.hashNew": { argTypes: [STRING], result: CRYPTOHASH_T },
  /** The Transform a Hash or Hmac reads and writes as a stream (+1,
   * created on first use and owned by the value; scr_stream.c). The Piped
   * form, for pipe destinations and pipeline stages, also keeps the value
   * alive until the stream flushes or is destroyed. */
  "crypto.hashStream": { argTypes: [null], result: { kind: "object", className: "%Transform" } },
  "crypto.hashStreamPiped": {
    argTypes: [null],
    result: { kind: "object", className: "%Transform" },
  },
  /** createCipheriv (false) / createDecipheriv (true) over checked-dynamic
   * cipher, key, iv and options arguments (scr_cipher.c): a native
   * Cipheriv/Decipheriv handle whose methods dispatch through dynInvoke. */
  "crypto.cipherNew": { argTypes: [BOOL, DYN, DYN, DYN, DYN], result: DYN },
  /** createECDH(curveName) over a checked-dynamic curve (scr_ecdh.c): a
   * native ECDH handle whose methods dispatch through dynInvoke. */
  "crypto.ecdhNew": { argTypes: [DYN], result: DYN },
  /** ECDH.convertKey(key, curve, inputEncoding, outputEncoding, format):
   * the converted point as a Buffer or string. */
  "crypto.ecdhConvertKey": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: DYN },
  /** createDiffieHellman(sizeOrKey, keyEncoding, generator,
   * generatorEncoding) over checked-dynamic arguments (scr_dh.c): a native
   * DiffieHellman handle whose methods dispatch through dynInvoke. */
  "crypto.dhNew": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  /** getDiffieHellman(groupName) and createDiffieHellmanGroup(name): a
   * native DiffieHellmanGroup handle. */
  "crypto.dhGroupNew": { argTypes: [DYN], result: DYN },
  /** checkPrimeSync(candidate, options) and generatePrimeSync(size,
   * options) over checked-dynamic arguments (scr_dh.c): a boolean, and an
   * ArrayBuffer or bigint, as checked-dynamic results. The Cb forms take
   * the callback and whether its error parameter takes null for Node's
   * undefined, and call it in a later macrotask; Node's argument errors
   * throw (may-throw). */
  "crypto.checkPrimeSync": { argTypes: [DYN, DYN], result: DYN },
  /** getCipherInfo(nameOrNid, options) over checked-dynamic arguments
   * (scr_cipher_info.c): the info object or undefined. */
  "crypto.getCipherInfo": { argTypes: [DYN, DYN], result: DYN },
  "crypto.checkPrimeCb": { argTypes: [DYN, DYN, DYN, BOOL], result: VOID },
  "crypto.generatePrimeSync": { argTypes: [DYN, DYN], result: DYN },
  "crypto.generatePrimeCb": { argTypes: [DYN, DYN, DYN, BOOL], result: VOID },
  "crypto.hmacNewStr": { argTypes: [STRING, STRING], result: CRYPTOHMAC_T },
  "crypto.hmacNewBytes": { argTypes: [STRING, BYTES_U8], result: CRYPTOHMAC_T },
  "crypto.hashUpdateStr": { argTypes: [CRYPTOHASH_T, STRING], result: CRYPTOHASH_T },
  "crypto.hashUpdateBytes": { argTypes: [CRYPTOHASH_T, BYTES_U8], result: CRYPTOHASH_T },
  "crypto.hmacUpdateStr": { argTypes: [CRYPTOHMAC_T, STRING], result: CRYPTOHMAC_T },
  "crypto.hmacUpdateBytes": { argTypes: [CRYPTOHMAC_T, BYTES_U8], result: CRYPTOHMAC_T },
  "crypto.hashCopy": { argTypes: [CRYPTOHASH_T], result: CRYPTOHASH_T },
  "crypto.hashDigestString": { argTypes: [CRYPTOHASH_T, STRING], result: STRING },
  "crypto.hashDigestBuffer": { argTypes: [CRYPTOHASH_T], result: BYTES_U8 },
  "crypto.hmacDigestString": { argTypes: [CRYPTOHMAC_T, STRING], result: STRING },
  "crypto.hmacDigestBuffer": { argTypes: [CRYPTOHMAC_T], result: BYTES_U8 },
  /** The option and any-value forms, with Node's checks at run time. The
   * Dyn digests return a string or a Buffer, and crypto.hash's Dyn form
   * either one by its outputEncoding. */
  "crypto.hashNewOpts": { argTypes: [STRING, DYN], result: CRYPTOHASH_T },
  "crypto.hmacNewDyn": { argTypes: [STRING, DYN, DYN], result: CRYPTOHMAC_T },
  /** createMac(algorithm, key[, options]) answers a Mac native handle. */
  "crypto.macNewDyn": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** crypto.secureHeapUsed() answers Node's no-secure-heap object. */
  "crypto.secureHeapUsed": { argTypes: [], result: DYN },
  "crypto.hashCopyOpts": { argTypes: [CRYPTOHASH_T, DYN], result: CRYPTOHASH_T },
  "crypto.hashUpdateEnc": { argTypes: [CRYPTOHASH_T, STRING, STRING], result: CRYPTOHASH_T },
  "crypto.hmacUpdateEnc": { argTypes: [CRYPTOHMAC_T, STRING, STRING], result: CRYPTOHMAC_T },
  "crypto.hashUpdateDyn": { argTypes: [CRYPTOHASH_T, DYN, DYN], result: CRYPTOHASH_T },
  "crypto.hmacUpdateDyn": { argTypes: [CRYPTOHMAC_T, DYN, DYN], result: CRYPTOHMAC_T },
  "crypto.hashDigestDyn": { argTypes: [CRYPTOHASH_T, DYN], result: DYN },
  "crypto.hmacDigestDyn": { argTypes: [CRYPTOHMAC_T, DYN], result: DYN },
  "crypto.hashOneshot": { argTypes: [STRING, DYN, DYN], result: DYN },
  /** The any-argument forms: Node's argument types are checked at run
   * time, in its order, for calls whose arguments do not fit the typed
   * signatures (missing ones read as undefined). */
  "crypto.hashNewAny": { argTypes: [DYN, DYN], result: CRYPTOHASH_T },
  "crypto.hmacNewAny": { argTypes: [DYN, DYN, DYN], result: CRYPTOHMAC_T },
  "crypto.hashOneshotAny": { argTypes: [DYN, DYN, DYN], result: DYN },
  "crypto.pbkdf2Any": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: BYTES_U8 },
  "crypto.pbkdf2AnyCb": { argTypes: [DYN, DYN, DYN, DYN, DYN, DYN], result: VOID },
  "crypto.hkdfAny": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: DYN },
  "crypto.hkdfAnyCb": { argTypes: [DYN, DYN, DYN, DYN, DYN, DYN], result: VOID },
  "crypto.scryptAny": { argTypes: [DYN, DYN, DYN, DYN], result: BYTES_U8 },
  "crypto.scryptAnyCb": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: VOID },
  /** Views of any element kind (the validator checks both are views). */
  "crypto.timingSafeEqual": { argTypes: [null, null], result: BOOL },
  "crypto.timingSafeEqualDyn": { argTypes: [DYN, DYN], result: BOOL },
  "crypto.randomFill": { argTypes: [BYTES_U8, F64, F64], result: BYTES_U8 },
  "crypto.randomFillRest": { argTypes: [BYTES_U8, F64], result: BYTES_U8 },
  "crypto.randomInt": { argTypes: [F64, F64], result: F64 },
  "crypto.randomIntMax": { argTypes: [F64], result: F64 },
  /** randomFillSync over any view returns that view at its own type (the
   * validator checks the result against the first argument). The Dyn form
   * takes ArrayBuffers and other values. The callback forms carry
   * randomFill's argument count before the callback; randomIntCb carries
   * whether min was given. */
  "crypto.randomFillView": { argTypes: [null, F64, F64], result: BYTES_U8 },
  "crypto.randomFillViewRest": { argTypes: [null, F64], result: BYTES_U8 },
  /** crypto.getRandomValues: a view returns itself at its own type (the
   * float/size DOMExceptions are thrown at run time); any other value
   * takes the checked form. */
  "crypto.getRandomValues": { argTypes: [null], result: BYTES_U8 },
  "crypto.getRandomValuesDyn": { argTypes: [DYN], result: DYN },
  "crypto.randomFillSyncDyn": { argTypes: [DYN, DYN, DYN], result: DYN },
  "crypto.randomFillCb": { argTypes: [null, F64, F64, F64, null], result: VOID },
  "crypto.randomFillCbDyn": { argTypes: [DYN, DYN, DYN, F64, null], result: VOID },
  "crypto.randomIntCb": { argTypes: [F64, F64, F64, null], result: VOID },
  "crypto.randomUUIDOpts": { argTypes: [DYN], result: STRING },
  /** Secret KeyObjects: native handles whose getters and methods dispatch
   * through the handle. keyObjectInput reads a key's bytes for hkdf. */
  "crypto.createSecretKey": { argTypes: [DYN, DYN], result: DYN },
  "crypto.generateKeySync": { argTypes: [DYN, DYN], result: DYN },
  "crypto.generateKeyCb": { argTypes: [DYN, DYN, null], result: VOID },
  /** Node's synchronous callback gate, for a callback only the dynamic
   * checker can see: a non-function throws ERR_INVALID_ARG_TYPE before
   * generateKey's type and options checks, where Node validates it. */
  "crypto.checkCallback": { argTypes: [DYN], result: VOID },
  "crypto.keyObjectInput": { argTypes: [DYN], result: BYTES_U8 },
  "crypto.isKeyObject": { argTypes: [DYN], result: BOOL },
  "crypto.argon2Sync": { argTypes: [DYN], result: DYN },
  "crypto.argon2Cb": { argTypes: [DYN], result: VOID },
  "crypto.randomUUIDv7": { argTypes: [DYN], result: STRING },
  "crypto.pbkdf2": { argTypes: [BYTES_U8, BYTES_U8, F64, F64, STRING], result: BYTES_U8 },
  "crypto.randomBytesCb": { argTypes: [F64, null], result: VOID },
  "crypto.randomBytesAny": { argTypes: [DYN, DYN], result: DYN },
  "crypto.randomIntAny": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** The checked-dynamic entries a call takes when its callback position
   * can hold a function: same checks, and the callback in a later
   * macrotask (the synchronous spellings above never schedule). */
  "crypto.randomBytesAnyCb": { argTypes: [DYN, DYN], result: DYN },
  "crypto.randomIntAnyCb": { argTypes: [DYN, DYN, DYN], result: DYN },
  "crypto.pbkdf2Cb": { argTypes: [BYTES_U8, BYTES_U8, F64, F64, STRING, null], result: VOID },
  "crypto.hkdf": { argTypes: [STRING, BYTES_U8, BYTES_U8, BYTES_U8, F64], result: DYN },
  "crypto.hkdfCb": { argTypes: [STRING, BYTES_U8, BYTES_U8, BYTES_U8, F64, null], result: VOID },
  "crypto.scrypt": { argTypes: [BYTES_U8, BYTES_U8, F64, DYN], result: BYTES_U8 },
  "crypto.scryptCb": { argTypes: [BYTES_U8, BYTES_U8, F64, DYN, null], result: VOID },
  /** util.promisify over the callback forms: the callback form's
   * arguments without the callback → a promise the callback form settles,
   * or rejected with an argument error; never throws. The result's value
   * type is the declared one (a Buffer, the filled view, a number, or a
   * checked-dynamic value); the validator checks it. */
  "crypto.randomBytesPromise": { argTypes: [F64], result: VOID },
  "crypto.pbkdf2Promise": { argTypes: [BYTES_U8, BYTES_U8, F64, F64, STRING], result: VOID },
  "crypto.scryptPromise": { argTypes: [BYTES_U8, BYTES_U8, F64, DYN], result: VOID },
  "crypto.hkdfPromise": { argTypes: [STRING, BYTES_U8, BYTES_U8, BYTES_U8, F64], result: VOID },
  "crypto.randomFillPromise": { argTypes: [null, F64, F64, F64], result: VOID },
  "crypto.randomFillPromiseDyn": { argTypes: [DYN, DYN, DYN, F64], result: VOID },
  "crypto.randomIntPromise": { argTypes: [F64, F64, F64], result: VOID },
  "crypto.generateKeyPromise": { argTypes: [DYN, DYN], result: VOID },
  /** node:crypto asymmetric keys and signatures (scr_pki.c): checked-
   * dynamic arguments, borrowed; KeyObject, Sign and Verify handles,
   * Buffers and booleans as checked-dynamic results (+1). Node's argument
   * and decoder errors throw (may-throw); generateKeyPairCb's callback
   * receives (null, publicKey, privateKey) in a later macrotask. */
  "crypto.createPrivateKey": { argTypes: [DYN], result: DYN },
  "crypto.createPublicKey": { argTypes: [DYN], result: DYN },
  /** crypto.parsePKCS12's parsed bundle and the three reads the frontend
   * composes Node's result record from (scr_pki.c): the parts handle, the
   * private key or null, a certificate's DER (index -1 is the matching one),
   * and the additional certificates' count. */
  "crypto.parsePKCS12": { argTypes: [DYN, DYN], result: DYN },
  "crypto.pkcs12Key": { argTypes: [DYN], result: DYN },
  "crypto.pkcs12Der": { argTypes: [DYN, F64], result: BYTES_U8 },
  "crypto.pkcs12Count": { argTypes: [DYN], result: F64 },
  "crypto.generateKeyPairSync": { argTypes: [DYN, DYN], result: DYN },
  "crypto.encapsulate": { argTypes: [DYN, DYN], result: DYN },
  "crypto.decapsulate": { argTypes: [DYN, DYN, DYN], result: DYN },
  "crypto.generateKeyPairCb": { argTypes: [DYN, DYN, DYN], result: VOID },
  "crypto.signOneshot": { argTypes: [DYN, DYN, DYN], result: DYN },
  "crypto.signOneshotCb": { argTypes: [DYN, DYN, DYN, DYN], result: VOID },
  "crypto.signOneshotMaybe": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  "crypto.diffieHellman": { argTypes: [DYN, DYN], result: DYN },
  "crypto.verifyOneshot": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  "crypto.verifyOneshotCb": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: VOID },
  "crypto.verifyOneshotMaybe": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: DYN },
  "crypto.publicEncrypt": { argTypes: [DYN, DYN], result: DYN },
  "crypto.privateDecrypt": { argTypes: [DYN, DYN], result: DYN },
  "crypto.privateEncrypt": { argTypes: [DYN, DYN], result: DYN },
  "crypto.publicDecrypt": { argTypes: [DYN, DYN], result: DYN },
  /** setEngine's checked-dynamic (engine[, flags]) form and the deprecated
   * crypto.fips read, which reports DEP0093 once per process. */
  "crypto.setEngine": { argTypes: [DYN, DYN], result: VOID },
  "crypto.fipsGet": { argTypes: [], result: F64 },
  "crypto.createSign": { argTypes: [DYN, DYN], result: DYN },
  "crypto.createVerify": { argTypes: [DYN, DYN], result: DYN },
});
