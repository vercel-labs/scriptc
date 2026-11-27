/* A private name reaches a value only through the brand check of the class
 * that declares it: a record a loader returns with a look-alike field is not
 * an instance, so reading the private name through it throws Node's
 * TypeError instead of answering the look-alike property. */
class Vault {
  #secret = "real";
  static read(target) {
    try {
      return `value:${target.#secret}`;
    } catch (error) {
      return `${error.name}:${error.message}`;
    }
  }
}
const fake = (id) => ({ "#secret": `fake:${id}` });
module["require"] = fake;
const loaded = module.require("node:path");
console.log(Vault.read(loaded));
console.log(Vault.read(new Vault()));
