// node:crypto ML-KEM raw key imports: the 64-byte seed makes the private
// key and its public half, the 800-byte raw public key imports as a public
// key, and the size, format and type errors match Node.
import { createPrivateKey, createPublicKey } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, run: () => unknown): void => {
  try { const k = run() as { type: string; asymmetricKeyType: string }; log(label, "ok", k.type, k.asymmetricKeyType); }
  catch (e) { const x = e as Error & { code?: string }; log(label, "|", x.name, x.code, "|", x.message); }
};

const seed512 = Buffer.from("e954ad9adfcfd48b9b1d3f854195ba7ba8cb81f3ed79d23a1c512d2164f08d4681620eef9268e7525b2ff97fde197bda8158955b1059d9a9a3ba8890b2e42a50", "hex");
const pub512 = Buffer.from("92c3cb1783a32a116ec69465ba397d2c8390898c6ea3f74ca991272977465cb84c2e431f4a92555883a31893277b228f080094536203fc8b9ae80049b9c6b3887a4c155b9847eb069af173ad923b314c144e13b06d000f87bc8c786a0d0cb954ee786e7ef0a6ce06a7f7594222e66950485cbab889fb0c17b3acc980954e430021769a44eb884b2515b66ca32f093120b1baa89aab3984202b07203654dcb2e688575efb2c785304dd98821859808d5c4216aa7d55bcc481fa282153a5aa10889430865dc598c520c05d953e207375d7f123b5c2a054b352d69165466b5360899a9eb7adace17d535745df239e352075fa776e5ca342cd96a8aa9b688a58bce9118ef13aa876461a1666408bc5203ee43e3a53c5ced60da13c917ab379d1d4bdbc959311f7c5d7d4ae51849c060200c0c4a82024b92822a37cdba6c34690e4c57446a21ddd543841a7bd46881aa0954012156b3675a3dd8355dc10ccb27b72923011439cc8b5f8c27178bfc7f59e99d85649ccbc5f71aa7f9477689a81ec6c16ea8cb1c9e717c01420595292155c7679430b5bc8c5b63c7dfd514260a189dc24a1d90694a3a93844675fd25cb121ea39b9bc124038655242accc28903cd9362caca3408c6d789bae12ba849a2a8829e195de9722ce86a0162c2762e469705757c8b66f3cecc3233c266c42655454586a3543d822a1f4205d1ed40d1c995f5ae6ba74e21e55192745aa149d4a990932baa28a05bac1c5322636ac8810eed3856a60a953f33d3fa430c100c7ace966ac5b77ac310a05d9298c7a7a425544d8b869d6283e4d4bb23a867863b52c0382b0e6c31f9e8518f678adfc76c301c369b6976c2915bab4c49808ab0cddb49124f23df8119fbc572f97ab02cc23ba1f102b5a65a310249fbc39b709350eaed31426321d577193d5f07a0e17a95992caa0a90c41e7b4c203bededb0217428620a48b0824180428c1e81960e1f984a375065224666c94589bc7b36082443caca8d586a32bb60041ec5b2e86b8298277132936ccb62c6a0c13aeca82aa6c5bfbb4b7f57545893565074c27e28c8711c69e3318a075702ba44c1c9ed5fa1bbefa8d72d1bdffadacd7562d29523a017010be6b5c64", "hex");

const priv = createPrivateKey({ key: seed512, format: "raw-seed", asymmetricKeyType: "ml-kem-512" } as never);
log("seed", priv.type, priv.asymmetricKeyType,
  Buffer.from(createPublicKey(priv).export({ type: "spki", format: "der" })).subarray(22).equals(pub512));
const fromSeed = createPublicKey({ key: seed512, format: "raw-seed", asymmetricKeyType: "ml-kem-512" } as never);
log("seed public", fromSeed.type, Buffer.from(fromSeed.export({ type: "spki", format: "der" })).length);
const fromRaw = createPublicKey({ key: pub512, format: "raw-public", asymmetricKeyType: "ml-kem-512" } as never);
log("raw public", fromRaw.type,
  Buffer.from(fromRaw.export({ type: "spki", format: "der" })).subarray(22).equals(pub512));

attempt("short seed", () => createPrivateKey({ key: Buffer.alloc(63), format: "raw-seed", asymmetricKeyType: "ml-kem-512" } as never));
attempt("long public", () => createPublicKey({ key: Buffer.alloc(801), format: "raw-public", asymmetricKeyType: "ml-kem-512" } as never));
attempt("raw private", () => createPrivateKey({ key: Buffer.alloc(1632), format: "raw-private", asymmetricKeyType: "ml-kem-512" } as never));
attempt("private raw public", () => createPrivateKey({ key: pub512, format: "raw-public", asymmetricKeyType: "ml-kem-512" } as never));
attempt("unknown level", () => createPublicKey({ key: pub512, format: "raw-public", asymmetricKeyType: "ml-kem-999" } as never));
