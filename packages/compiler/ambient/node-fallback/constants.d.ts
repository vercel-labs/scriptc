/* node:constants (deprecated, DEP0008) — one frozen object: os.constants'
 * dlopen, errno, priority and signals groups, fs.constants, and
 * crypto.constants. A platform's missing constant reads as undefined. */
declare module "constants" {
  const constants: { readonly [name: string]: number } & {
    readonly defaultCoreCipherList: string;
    readonly defaultCipherList: string;
  };
  export = constants;
}

declare module "node:constants" {
  import constants = require("constants");
  export = constants;
}
