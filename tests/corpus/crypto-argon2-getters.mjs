// crypto.argon2 with throwing secret/associatedData getters: the getter's
// error is thrown synchronously, the derivation never runs, and no callback
// is queued.
import { argon2 } from "node:crypto";

const base = {
  message: "password",
  nonce: Buffer.alloc(16, 1),
  parallelism: 1,
  tagLength: 32,
  memory: 1024,
  passes: 2,
};

for (const member of ["secret", "associatedData"]) {
  const parameters = { ...base };
  Object.defineProperty(parameters, member, {
    enumerable: true,
    get() {
      throw new Error(`${member} boom`);
    },
  });
  try {
    argon2("argon2id", parameters, () => console.log(member, "callback ran"));
    console.log(member, "no throw");
  } catch (error) {
    console.log(member, error.name, error.message);
  }
}

setTimeout(() => console.log("end"), 20);
