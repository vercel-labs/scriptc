/// <reference path="./stream.d.ts" />
/// <reference path="./tls.d.ts" />

/* node:crypto: the static hashing/MAC/random/key-derivation utility slice. */
declare module "crypto" {
  import { Transform } from "stream";
  export type KeyObjectType = "secret" | "public" | "private";
  export interface JsonWebKey {
    crv?: string;
    d?: string;
    dp?: string;
    dq?: string;
    e?: string;
    k?: string;
    kty?: string;
    n?: string;
    p?: string;
    q?: string;
    qi?: string;
    x?: string;
    y?: string;
    [key: string]: unknown;
  }
  export interface JwkKeyExportOptions {
    format: "jwk";
  }
  export interface KeyExportOptions {
    format?: "buffer" | undefined;
  }
  export type KeyFormat = "pem" | "der" | "jwk";
  export interface AsymmetricKeyExportOptions<T extends KeyFormat> {
    type: "pkcs1" | "spki" | "pkcs8" | "sec1";
    format: T;
    cipher?: string | undefined;
    passphrase?: string | Buffer | undefined;
  }
  export interface AsymmetricKeyDetails {
    modulusLength?: number;
    publicExponent?: bigint;
    namedCurve?: string;
  }
  /* Secret keys, and RSA and EC private and public keys. */
  export class KeyObject {
    private constructor();
    type: KeyObjectType;
    symmetricKeySize?: number;
    asymmetricKeyType?: string;
    asymmetricKeyDetails?: AsymmetricKeyDetails;
    export(options: AsymmetricKeyExportOptions<"pem">): string | Buffer;
    export(options: AsymmetricKeyExportOptions<"der">): Buffer;
    export(options?: KeyExportOptions): Buffer;
    export(options: JwkKeyExportOptions): JsonWebKey;
    equals(otherKeyObject: KeyObject): boolean;
  }
  export interface PrivateKeyInput {
    key: string | Buffer;
    format?: "pem" | "der" | undefined;
    type?: "pkcs1" | "pkcs8" | "sec1" | undefined;
    encoding?: string | undefined;
    passphrase?: string | Buffer | undefined;
  }
  export interface PublicKeyInput {
    key: string | Buffer;
    format?: "pem" | "der" | undefined;
    type?: "pkcs1" | "spki" | undefined;
    encoding?: string | undefined;
  }
  export interface JsonWebKeyInput {
    key: JsonWebKey;
    format: "jwk";
  }
  export function createPrivateKey(
    key: PrivateKeyInput | string | Buffer | JsonWebKeyInput,
  ): KeyObject;
  export function createPublicKey(
    key: PublicKeyInput | string | Buffer | KeyObject | JsonWebKeyInput,
  ): KeyObject;
  export interface KeyPairKeyObjectResult {
    publicKey: KeyObject;
    privateKey: KeyObject;
  }
  export interface KeyPairSyncResult<T1 extends string | Buffer, T2 extends string | Buffer> {
    publicKey: T1;
    privateKey: T2;
  }
  export interface RSAKeyPairKeyObjectOptions {
    modulusLength: number;
    publicExponent?: number | undefined;
  }
  export interface ECKeyPairKeyObjectOptions {
    namedCurve: string;
  }
  export interface RSAKeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    modulusLength: number;
    publicExponent?: number | undefined;
    publicKeyEncoding: { type: "pkcs1" | "spki"; format: PubF };
    privateKeyEncoding: {
      type: "pkcs1" | "pkcs8";
      format: PrivF;
      cipher?: string | undefined;
      passphrase?: string | undefined;
    };
  }
  export interface ECKeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    namedCurve: string;
    publicKeyEncoding: { type: "pkcs1" | "spki"; format: PubF };
    privateKeyEncoding: {
      type: "sec1" | "pkcs8";
      format: PrivF;
      cipher?: string | undefined;
      passphrase?: string | undefined;
    };
  }
  export function generateKeyPairSync(
    type: "rsa",
    options: RSAKeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "rsa",
    options: RSAKeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(
    type: "rsa",
    options: RSAKeyPairKeyObjectOptions,
  ): KeyPairKeyObjectResult;
  export function generateKeyPairSync(
    type: "ec",
    options: ECKeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "ec",
    options: ECKeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(
    type: "ec",
    options: ECKeyPairKeyObjectOptions,
  ): KeyPairKeyObjectResult;
  export interface ED25519KeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    publicKeyEncoding: { type: "spki"; format: PubF };
    privateKeyEncoding: {
      type: "pkcs8";
      format: PrivF;
      cipher?: string | undefined;
      passphrase?: string | undefined;
    };
  }
  export function generateKeyPairSync(
    type: "ed25519",
    options: ED25519KeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "ed25519",
    options: ED25519KeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(type: "ed25519", options?: {}): KeyPairKeyObjectResult;
  export interface X25519KeyPairOptions<PubF extends KeyFormat, PrivF extends KeyFormat> {
    publicKeyEncoding: { type: "spki"; format: PubF };
    privateKeyEncoding: {
      type: "pkcs8";
      format: PrivF;
      cipher?: string | undefined;
      passphrase?: string | undefined;
    };
  }
  export function generateKeyPairSync(
    type: "x25519",
    options: X25519KeyPairOptions<"pem", "pem">,
  ): KeyPairSyncResult<string, string>;
  export function generateKeyPairSync(
    type: "x25519",
    options: X25519KeyPairOptions<"der", "der">,
  ): KeyPairSyncResult<Buffer, Buffer>;
  export function generateKeyPairSync(type: "x25519", options?: {}): KeyPairKeyObjectResult;
  export function generateKeyPair(
    type: "x25519",
    options: {} | undefined,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export function generateKeyPair(
    type: "ed25519",
    options: {} | undefined,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export function generateKeyPair(
    type: "rsa",
    options: RSAKeyPairKeyObjectOptions,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export function generateKeyPair(
    type: "ec",
    options: ECKeyPairKeyObjectOptions,
    callback: (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) => void,
  ): void;
  export interface SigningOptions {
    padding?: number | undefined;
    saltLength?: number | undefined;
    dsaEncoding?: "der" | "ieee-p1363" | undefined;
  }
  export interface SignPrivateKeyInput extends PrivateKeyInput, SigningOptions {}
  export interface SignKeyObjectInput extends SigningOptions {
    key: KeyObject;
  }
  export interface VerifyPublicKeyInput extends PublicKeyInput, SigningOptions {}
  export interface VerifyKeyObjectInput extends SigningOptions {
    key: KeyObject;
  }
  export function diffieHellman(options: { privateKey: KeyObject; publicKey: KeyObject }): Buffer;
  export function diffieHellman(
    options: { privateKey: KeyObject; publicKey: KeyObject },
    callback: (err: Error | null, secret: Buffer) => void,
  ): void;
  export function sign(
    algorithm: string | null | undefined,
    data: ArrayBufferView,
    key: KeyObject | string | Buffer | SignKeyObjectInput | SignPrivateKeyInput,
  ): Buffer;
  export function verify(
    algorithm: string | null | undefined,
    data: ArrayBufferView,
    key: KeyObject | string | Buffer | VerifyKeyObjectInput | VerifyPublicKeyInput,
    signature: ArrayBufferView,
  ): boolean;
  /* Sign and Verify accumulate update() data; they are not usable as
   * writable streams. */
  export class Sign {
    private constructor();
    update(data: string | ArrayBufferView): this;
    update(data: string, inputEncoding: Encoding): this;
    sign(
      privateKey: KeyObject | string | Buffer | SignKeyObjectInput | SignPrivateKeyInput,
    ): Buffer;
    sign(
      privateKey: KeyObject | string | Buffer | SignKeyObjectInput | SignPrivateKeyInput,
      outputFormat: BinaryToTextEncoding,
    ): string;
  }
  export class Verify {
    private constructor();
    update(data: string | ArrayBufferView): this;
    update(data: string, inputEncoding: Encoding): this;
    verify(
      object: KeyObject | string | Buffer | VerifyKeyObjectInput | VerifyPublicKeyInput,
      signature: ArrayBufferView,
    ): boolean;
    verify(
      object: KeyObject | string | Buffer | VerifyKeyObjectInput | VerifyPublicKeyInput,
      signature: string,
      signatureEncoding?: BinaryToTextEncoding,
    ): boolean;
  }
  export function createSign(algorithm: string): Sign;
  export function createVerify(algorithm: string): Verify;
  export function createSecretKey(key: ArrayBufferView | ArrayBufferLike): KeyObject;
  export function createSecretKey(key: string, encoding: BufferEncoding): KeyObject;
  export function generateKeySync(type: "hmac" | "aes", options: { length: number }): KeyObject;
  export function generateKey(
    type: "hmac" | "aes",
    options: { length: number },
    callback: (err: Error | null, key: KeyObject) => void,
  ): void;
  export interface RandomUUIDOptions {
    disableEntropyCache?: boolean | undefined;
  }
  export function randomUUID(options?: RandomUUIDOptions): string;
  export function randomUUIDv7(options?: RandomUUIDOptions): string;
  export function randomBytes(size: number): Buffer;
  export type BinaryToTextEncoding = "base64" | "base64url" | "hex" | "binary";
  export type CharacterEncoding = "utf8" | "utf-8" | "utf16le" | "utf-16le" | "latin1";
  export type LegacyCharacterEncoding = "ascii" | "binary" | "ucs2" | "ucs-2";
  export type Encoding = BinaryToTextEncoding | CharacterEncoding | LegacyCharacterEncoding;
  export interface HashOptions {
    outputLength?: number | undefined;
  }
  /* Hash and Hmac are Transforms: written chunks update the digest, which
   * the readable side delivers once the writable side ends. */
  export interface Hash extends Transform {
    copy(options?: HashOptions): Hash;
    update(data: string | ArrayBufferView): Hash;
    update(data: string, inputEncoding: Encoding): Hash;
    digest(): Buffer;
    digest(encoding: BinaryToTextEncoding): string;
  }
  export interface Hmac extends Transform {
    update(data: string | ArrayBufferView): Hmac;
    update(data: string, inputEncoding: Encoding): Hmac;
    digest(): Buffer;
    digest(encoding: BinaryToTextEncoding): string;
  }
  export function createHash(algorithm: string, options?: HashOptions): Hash;
  export function createHmac(
    algorithm: string,
    key: BinaryLike | KeyObject,
    options?: { encoding?: BufferEncoding | undefined },
  ): Hmac;
  export interface OneShotDigestOptions {
    outputEncoding?: BinaryToTextEncoding | "buffer" | undefined;
    outputLength?: number | undefined;
  }
  export interface OneShotDigestOptionsWithStringEncoding extends OneShotDigestOptions {
    outputEncoding?: BinaryToTextEncoding | undefined;
  }
  export interface OneShotDigestOptionsWithBufferEncoding extends OneShotDigestOptions {
    outputEncoding: "buffer";
  }
  export function hash(
    algorithm: string,
    data: string | ArrayBufferView,
    options?: OneShotDigestOptionsWithStringEncoding | BinaryToTextEncoding,
  ): string;
  export function hash(
    algorithm: string,
    data: string | ArrayBufferView,
    options: OneShotDigestOptionsWithBufferEncoding | "buffer",
  ): Buffer;
  export function hash(
    algorithm: string,
    data: string | ArrayBufferView,
    options: OneShotDigestOptions | BinaryToTextEncoding | "buffer",
  ): string | Buffer;
  export function timingSafeEqual(
    a: ArrayBufferView | ArrayBufferLike,
    b: ArrayBufferView | ArrayBufferLike,
  ): boolean;
  /* WebCrypto's getRandomValues (also the webcrypto object's): integer
   * typed arrays, filled in place and returned. */
  type RandomValuesArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | BigInt64Array
    | BigUint64Array;
  export function getRandomValues<T extends RandomValuesArray>(typedArray: T): T;
  /* The WebCrypto global's object and its SubtleCrypto. */
  export const webcrypto: Crypto;
  export const subtle: SubtleCrypto;
  export function randomFillSync<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset?: number,
    size?: number,
  ): T;
  export function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    callback: (err: Error | null, buf: T) => void,
  ): void;
  export function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset: number,
    callback: (err: Error | null, buf: T) => void,
  ): void;
  export function randomFill<T extends ArrayBufferView | ArrayBufferLike>(
    buffer: T,
    offset: number,
    size: number,
    callback: (err: Error | null, buf: T) => void,
  ): void;
  export function randomInt(max: number): number;
  export function randomInt(min: number, max: number): number;
  export function randomInt(
    max: number,
    callback: (err: Error | null, value: number) => void,
  ): void;
  export function randomInt(
    min: number,
    max: number,
    callback: (err: Error | null, value: number) => void,
  ): void;
  export function pbkdf2Sync(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
  ): Buffer;
  export function pbkdf2(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function randomBytes(
    size: number,
    callback: (error: Error | null, buffer: Buffer) => void,
  ): void;
  export type BinaryLike = string | ArrayBuffer | ArrayBufferView;
  /* Cipheriv/Decipheriv: aes-128/192/256 in cbc, ctr, gcm, ccm, ecb, cfb,
   * cfb8, cfb1, and ofb modes and their key wraps, des-ede3 and des-ede,
   * chacha20, and chacha20-poly1305. Both are Transforms: written chunks go
   * through update(), and the end pushes final(). */
  export type CipherCCMTypes = "aes-128-ccm" | "aes-192-ccm" | "aes-256-ccm";
  export type CipherGCMTypes = "aes-128-gcm" | "aes-192-gcm" | "aes-256-gcm";
  export type CipherChaCha20Poly1305Types = "chacha20-poly1305";
  export type CipherKey = BinaryLike | KeyObject;
  export interface CipherCCMOptions {
    authTagLength: number;
  }
  export interface CipherGCMOptions {
    authTagLength?: number;
  }
  export interface CipherChaCha20Poly1305Options {
    authTagLength?: number;
  }
  export interface Cipheriv extends Transform {
    update(data: string | ArrayBufferView): Buffer;
    update(data: string, inputEncoding: BufferEncoding): Buffer;
    update(data: ArrayBufferView, inputEncoding: undefined, outputEncoding: BufferEncoding): string;
    update(
      data: string,
      inputEncoding: BufferEncoding | undefined,
      outputEncoding: BufferEncoding,
    ): string;
    final(): Buffer;
    final(outputEncoding: BufferEncoding): string;
    setAutoPadding(autoPadding?: boolean): this;
  }
  export interface CipherCCM extends Cipheriv {
    setAAD(buffer: ArrayBufferView, options: { plaintextLength: number }): this;
    getAuthTag(): Buffer;
  }
  export interface CipherGCM extends Cipheriv {
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
    getAuthTag(): Buffer;
  }
  export interface CipherChaCha20Poly1305 extends Cipheriv {
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
    getAuthTag(): Buffer;
  }
  export interface Decipheriv extends Transform {
    update(data: ArrayBufferView): Buffer;
    update(data: string, inputEncoding: BufferEncoding): Buffer;
    update(data: ArrayBufferView, inputEncoding: undefined, outputEncoding: BufferEncoding): string;
    update(
      data: string,
      inputEncoding: BufferEncoding | undefined,
      outputEncoding: BufferEncoding,
    ): string;
    final(): Buffer;
    final(outputEncoding: BufferEncoding): string;
    setAutoPadding(autoPadding?: boolean): this;
  }
  export interface DecipherCCM extends Decipheriv {
    setAuthTag(buffer: ArrayBufferView): this;
    setAAD(buffer: ArrayBufferView, options: { plaintextLength: number }): this;
  }
  export interface DecipherGCM extends Decipheriv {
    setAuthTag(buffer: ArrayBufferView): this;
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
  }
  export interface DecipherChaCha20Poly1305 extends Decipheriv {
    setAuthTag(buffer: ArrayBufferView): this;
    setAAD(buffer: ArrayBufferView, options?: { plaintextLength: number }): this;
  }
  export function createCipheriv(
    algorithm: CipherCCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options: CipherCCMOptions,
  ): CipherCCM;
  export function createCipheriv(
    algorithm: CipherGCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherGCMOptions,
  ): CipherGCM;
  export function createCipheriv(
    algorithm: CipherChaCha20Poly1305Types,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherChaCha20Poly1305Options,
  ): CipherChaCha20Poly1305;
  export function createCipheriv(
    algorithm: string,
    key: CipherKey,
    iv: BinaryLike | null,
    options?: { authTagLength?: number },
  ): Cipheriv;
  export function createDecipheriv(
    algorithm: CipherCCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options: CipherCCMOptions,
  ): DecipherCCM;
  export function createDecipheriv(
    algorithm: CipherGCMTypes,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherGCMOptions,
  ): DecipherGCM;
  export function createDecipheriv(
    algorithm: CipherChaCha20Poly1305Types,
    key: CipherKey,
    iv: BinaryLike,
    options?: CipherChaCha20Poly1305Options,
  ): DecipherChaCha20Poly1305;
  export function createDecipheriv(
    algorithm: string,
    key: CipherKey,
    iv: BinaryLike | null,
    options?: { authTagLength?: number },
  ): Decipheriv;
  export type ECDHKeyFormat = "compressed" | "uncompressed" | "hybrid";
  export class ECDH {
    private constructor();
    static convertKey(
      key: BinaryLike,
      curve: string,
      inputEncoding?: BinaryToTextEncoding,
      outputEncoding?: "latin1" | "hex" | "base64" | "base64url",
      format?: ECDHKeyFormat,
    ): Buffer | string;
    generateKeys(): Buffer;
    generateKeys(encoding: BinaryToTextEncoding, format?: ECDHKeyFormat): string;
    computeSecret(otherPublicKey: ArrayBufferView): Buffer;
    computeSecret(otherPublicKey: string, inputEncoding: BinaryToTextEncoding): Buffer;
    computeSecret(otherPublicKey: ArrayBufferView, outputEncoding: BinaryToTextEncoding): string;
    computeSecret(
      otherPublicKey: string,
      inputEncoding: BinaryToTextEncoding,
      outputEncoding: BinaryToTextEncoding,
    ): string;
    getPrivateKey(): Buffer;
    getPrivateKey(encoding: BinaryToTextEncoding): string;
    getPublicKey(encoding?: null, format?: ECDHKeyFormat): Buffer;
    getPublicKey(encoding: BinaryToTextEncoding, format?: ECDHKeyFormat): string;
    setPrivateKey(privateKey: ArrayBufferView): void;
    setPrivateKey(privateKey: string, encoding: BinaryToTextEncoding): void;
  }
  export function createECDH(curveName: string): ECDH;
  export class DiffieHellman {
    private constructor();
    generateKeys(): Buffer;
    generateKeys(encoding: BinaryToTextEncoding): string;
    computeSecret(
      otherPublicKey: ArrayBufferView,
      inputEncoding?: null,
      outputEncoding?: null,
    ): Buffer;
    computeSecret(
      otherPublicKey: string,
      inputEncoding: BinaryToTextEncoding,
      outputEncoding?: null,
    ): Buffer;
    computeSecret(
      otherPublicKey: ArrayBufferView,
      inputEncoding: null,
      outputEncoding: BinaryToTextEncoding,
    ): string;
    computeSecret(
      otherPublicKey: string,
      inputEncoding: BinaryToTextEncoding,
      outputEncoding: BinaryToTextEncoding,
    ): string;
    getPrime(): Buffer;
    getPrime(encoding: BinaryToTextEncoding): string;
    getGenerator(): Buffer;
    getGenerator(encoding: BinaryToTextEncoding): string;
    getPublicKey(): Buffer;
    getPublicKey(encoding: BinaryToTextEncoding): string;
    getPrivateKey(): Buffer;
    getPrivateKey(encoding: BinaryToTextEncoding): string;
    setPublicKey(publicKey: ArrayBufferView): void;
    setPublicKey(publicKey: string, encoding: BufferEncoding): void;
    setPrivateKey(privateKey: ArrayBufferView): void;
    setPrivateKey(privateKey: string, encoding: BufferEncoding): void;
    verifyError: number;
  }
  export type DiffieHellmanGroup = Omit<DiffieHellman, "setPublicKey" | "setPrivateKey">;
  export function createDiffieHellman(primeLength: number, generator?: number): DiffieHellman;
  export function createDiffieHellman(
    prime: ArrayBuffer | ArrayBufferView,
    generator?: number | ArrayBuffer | ArrayBufferView,
  ): DiffieHellman;
  export function createDiffieHellman(
    prime: ArrayBuffer | ArrayBufferView,
    generator: string,
    generatorEncoding: BinaryToTextEncoding,
  ): DiffieHellman;
  export function createDiffieHellman(
    prime: string,
    primeEncoding: BinaryToTextEncoding,
    generator?: number | ArrayBuffer | ArrayBufferView,
  ): DiffieHellman;
  export function createDiffieHellman(
    prime: string,
    primeEncoding: BinaryToTextEncoding,
    generator: string,
    generatorEncoding: BinaryToTextEncoding,
  ): DiffieHellman;
  export function getDiffieHellman(groupName: string): DiffieHellmanGroup;
  export function createDiffieHellmanGroup(name: string): DiffieHellmanGroup;
  export type LargeNumberLike = ArrayBufferView | SharedArrayBuffer | ArrayBuffer | bigint;
  export interface GeneratePrimeOptions {
    add?: LargeNumberLike | undefined;
    rem?: LargeNumberLike | undefined;
    safe?: boolean | undefined;
    bigint?: boolean | undefined;
  }
  export interface GeneratePrimeOptionsBigInt extends GeneratePrimeOptions {
    bigint: true;
  }
  export interface GeneratePrimeOptionsArrayBuffer extends GeneratePrimeOptions {
    bigint?: false | undefined;
  }
  export function generatePrime(
    size: number,
    callback: (err: Error | null, prime: ArrayBuffer) => void,
  ): void;
  export function generatePrime(
    size: number,
    options: GeneratePrimeOptionsBigInt,
    callback: (err: Error | null, prime: bigint) => void,
  ): void;
  export function generatePrime(
    size: number,
    options: GeneratePrimeOptionsArrayBuffer,
    callback: (err: Error | null, prime: ArrayBuffer) => void,
  ): void;
  export function generatePrime(
    size: number,
    options: GeneratePrimeOptions,
    callback: (err: Error | null, prime: ArrayBuffer | bigint) => void,
  ): void;
  export function generatePrimeSync(size: number): ArrayBuffer;
  export function generatePrimeSync(size: number, options: GeneratePrimeOptionsBigInt): bigint;
  export function generatePrimeSync(
    size: number,
    options: GeneratePrimeOptionsArrayBuffer,
  ): ArrayBuffer;
  export function generatePrimeSync(
    size: number,
    options: GeneratePrimeOptions,
  ): ArrayBuffer | bigint;
  export interface CheckPrimeOptions {
    checks?: number | undefined;
  }
  export function checkPrime(
    value: LargeNumberLike,
    callback: (err: Error | null, result: boolean) => void,
  ): void;
  export function checkPrime(
    value: LargeNumberLike,
    options: CheckPrimeOptions,
    callback: (err: Error | null, result: boolean) => void,
  ): void;
  export function checkPrimeSync(candidate: LargeNumberLike, options?: CheckPrimeOptions): boolean;
  export interface ScryptOptions {
    N?: number;
    r?: number;
    p?: number;
    cost?: number;
    blockSize?: number;
    parallelization?: number;
    maxmem?: number;
  }
  export function scryptSync(
    password: BinaryLike,
    salt: BinaryLike,
    keylen: number,
    options?: ScryptOptions,
  ): Buffer;
  export function scrypt(
    password: BinaryLike,
    salt: BinaryLike,
    keylen: number,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function scrypt(
    password: BinaryLike,
    salt: BinaryLike,
    keylen: number,
    options: ScryptOptions,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void;
  export function hkdfSync(
    digest: string,
    ikm: BinaryLike | KeyObject,
    salt: BinaryLike,
    info: BinaryLike,
    keylen: number,
  ): ArrayBuffer;
  export function hkdf(
    digest: string,
    ikm: BinaryLike | KeyObject,
    salt: BinaryLike,
    info: BinaryLike,
    keylen: number,
    callback: (error: Error | null, derivedKey: ArrayBuffer) => void,
  ): void;
  /* The lowered X509Certificate surface is the data-record slice: the
   * fields below, all computed at construction (raw decodes the input,
   * and the others read raw). validFrom/validTo are Node's
   * ASN1_TIME_print strings ("Jul  1 00:00:00 2026 GMT"). Unparseable
   * input throws Node's ERR_OSSL_PEM_NO_START_LINE Error. */
  export class X509Certificate {
    constructor(buffer: Uint8Array | string);
    readonly ca: boolean;
    readonly fingerprint: string;
    readonly fingerprint256: string;
    readonly fingerprint512: string;
    readonly subject: string;
    readonly subjectAltName: string | undefined;
    readonly infoAccess: string | undefined;
    readonly issuer: string;
    readonly raw: Buffer;
    readonly serialNumber: string;
    readonly signatureAlgorithm: string | undefined;
    readonly signatureAlgorithmOid: string;
    readonly validFrom: string;
    readonly validFromDate: Date;
    readonly validTo: string;
    readonly validToDate: Date;
    /* the certificate's public key; every read answers the same KeyObject */
    readonly publicKey: KeyObject;
    verify(publicKey: KeyObject): boolean;
    checkPrivateKey(privateKey: KeyObject): boolean;
    checkIssued(otherCert: X509Certificate): boolean;
    checkHost(name: string, options?: X509CheckOptions): string | undefined;
    checkEmail(email: string, options?: X509CheckOptions): string | undefined;
    checkIP(ip: string): string | undefined;
    toLegacyObject(): import("tls").PeerCertificate;
  }
  export interface X509CheckOptions {
    subject?: "always" | "default" | "never";
    wildcards?: boolean;
    partialWildcards?: boolean;
    multiLabelWildcards?: boolean;
    singleLabelSubdomains?: boolean;
  }
  /* The crypto introspection statics: getFips() answers 0 (a compiled
   * binary is never a FIPS build), the three name lists bake as fresh
   * string[] literals of Node v24 answers, and constants (below) bakes
   * per member like http2.constants. */
  export function getFips(): 1 | 0;
  export function getCiphers(): string[];
  export type CipherMode =
    | "cbc"
    | "ccm"
    | "cfb"
    | "ctr"
    | "ecb"
    | "gcm"
    | "ocb"
    | "ofb"
    | "stream"
    | "wrap"
    | "xts";
  export interface CipherInfoOptions {
    keyLength?: number | undefined;
    ivLength?: number | undefined;
  }
  export interface CipherInfo {
    name: string;
    nid: number;
    blockSize?: number | undefined;
    ivLength?: number | undefined;
    keyLength: number;
    mode: CipherMode;
  }
  export function getCipherInfo(
    nameOrNid: string | number,
    options?: CipherInfoOptions,
  ): CipherInfo | undefined;
  export function getHashes(): string[];
  export function getCurves(): string[];
  /* Node v24 crypto.constants, literal-typed (the Http2Constants
   * stance). Every ACCESS bakes as its literal at lowering; the object
   * itself never materializes (bare crypto.constants value uses fence). */
  export interface CryptoConstants {
    readonly OPENSSL_VERSION_NUMBER: 810549376;
    readonly SSL_OP_ALL: 2147485776;
    readonly SSL_OP_ALLOW_NO_DHE_KEX: 1024;
    readonly SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144;
    readonly SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304;
    readonly SSL_OP_CISCO_ANYCONNECT: 32768;
    readonly SSL_OP_COOKIE_EXCHANGE: 8192;
    readonly SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648;
    readonly SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048;
    readonly SSL_OP_LEGACY_SERVER_CONNECT: 4;
    readonly SSL_OP_NO_COMPRESSION: 131072;
    readonly SSL_OP_NO_ENCRYPT_THEN_MAC: 524288;
    readonly SSL_OP_NO_QUERY_MTU: 4096;
    readonly SSL_OP_NO_RENEGOTIATION: 1073741824;
    readonly SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536;
    readonly SSL_OP_NO_SSLv2: 0;
    readonly SSL_OP_NO_SSLv3: 33554432;
    readonly SSL_OP_NO_TICKET: 16384;
    readonly SSL_OP_NO_TLSv1: 67108864;
    readonly SSL_OP_NO_TLSv1_1: 268435456;
    readonly SSL_OP_NO_TLSv1_2: 134217728;
    readonly SSL_OP_NO_TLSv1_3: 536870912;
    readonly SSL_OP_PRIORITIZE_CHACHA: 2097152;
    readonly SSL_OP_TLS_ROLLBACK_BUG: 8388608;
    readonly ENGINE_METHOD_RSA: 1;
    readonly ENGINE_METHOD_DSA: 2;
    readonly ENGINE_METHOD_DH: 4;
    readonly ENGINE_METHOD_RAND: 8;
    readonly ENGINE_METHOD_EC: 2048;
    readonly ENGINE_METHOD_CIPHERS: 64;
    readonly ENGINE_METHOD_DIGESTS: 128;
    readonly ENGINE_METHOD_PKEY_METHS: 512;
    readonly ENGINE_METHOD_PKEY_ASN1_METHS: 1024;
    readonly ENGINE_METHOD_ALL: 65535;
    readonly ENGINE_METHOD_NONE: 0;
    readonly DH_CHECK_P_NOT_SAFE_PRIME: 2;
    readonly DH_CHECK_P_NOT_PRIME: 1;
    readonly DH_UNABLE_TO_CHECK_GENERATOR: 4;
    readonly DH_NOT_SUITABLE_GENERATOR: 8;
    readonly RSA_PKCS1_PADDING: 1;
    readonly RSA_SSLV23_PADDING: 2;
    readonly RSA_NO_PADDING: 3;
    readonly RSA_PKCS1_OAEP_PADDING: 4;
    readonly RSA_X931_PADDING: 5;
    readonly RSA_PKCS1_PSS_PADDING: 6;
    readonly RSA_PSS_SALTLEN_DIGEST: -1;
    readonly RSA_PSS_SALTLEN_MAX_SIGN: -2;
    readonly RSA_PSS_SALTLEN_AUTO: -2;
    readonly defaultCoreCipherList: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
    readonly TLS1_VERSION: 769;
    readonly TLS1_1_VERSION: 770;
    readonly TLS1_2_VERSION: 771;
    readonly TLS1_3_VERSION: 772;
    readonly POINT_CONVERSION_COMPRESSED: 2;
    readonly POINT_CONVERSION_UNCOMPRESSED: 4;
    readonly POINT_CONVERSION_HYBRID: 6;
    readonly defaultCipherList: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
  }
  export const constants: CryptoConstants;
}

declare module "node:crypto" {
  export * from "crypto";
}
