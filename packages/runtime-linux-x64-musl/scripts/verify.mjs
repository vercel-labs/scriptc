import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
process.env.SCRIPTC_RUNTIME_PACK_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); await import("../../runtime-pack-common/scripts/verify.mjs");
