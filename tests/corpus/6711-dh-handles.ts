// DiffieHellman and DiffieHellmanGroup values as ordinary values: class
// fields, optional fields, arrays, Map values, parameters and return
// values, with verifyError read through each.
import * as crypto from "node:crypto";
import { type DiffieHellman, type DiffieHellmanGroup } from "node:crypto";

const prime = crypto.getDiffieHellman("modp1").getPrime();

class Party {
  readonly dh: DiffieHellman;
  peer: DiffieHellman | null = null;
  group?: DiffieHellmanGroup;

  constructor(seed: number) {
    this.dh = crypto.createDiffieHellman(prime, 2);
    this.dh.setPrivateKey(Buffer.from([seed, seed + 1, seed + 2]));
    this.dh.generateKeys();
  }

  secretWith(other: Party): string {
    return this.dh.computeSecret(other.dh.getPublicKey(), null, "hex");
  }
}

const alice = new Party(1);
const bob = new Party(7);
alice.peer = bob.dh;
console.log(alice.secretWith(bob) === bob.secretWith(alice), alice.secretWith(bob).slice(0, 32));
console.log(alice.peer !== null && alice.peer.getPublicKey().equals(bob.dh.getPublicKey()));
console.log(alice.group === undefined);
alice.group = crypto.getDiffieHellman("modp2");
console.log(alice.group.verifyError, alice.group.getPrime().length);

function verify(dh: DiffieHellman | DiffieHellmanGroup): number {
  return dh.verifyError;
}

function make(bytes: number[]): DiffieHellman {
  return crypto.createDiffieHellman(Buffer.from(bytes));
}

const all: (DiffieHellman | DiffieHellmanGroup)[] = [alice.dh, make([23]), make([24]), crypto.getDiffieHellman("modp5")];
console.log(all.map(verify).join(","));
for (const dh of all) console.log(dh.getGenerator("hex"), dh.getPrime().length);

const byName = new Map<string, DiffieHellmanGroup>();
for (const name of ["modp1", "modp2"]) byName.set(name, crypto.createDiffieHellmanGroup(name));
for (const [name, group] of byName) {
  group.generateKeys();
  console.log(name, group.getGenerator("hex"), group.computeSecret(alice.dh.getPublicKey()).length);
}

let maybe: DiffieHellman | undefined;
console.log(maybe?.verifyError);
maybe = make([0x0d]);
console.log(maybe?.verifyError, maybe.getPrime("hex"));
