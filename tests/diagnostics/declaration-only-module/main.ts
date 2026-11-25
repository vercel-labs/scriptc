// A value import whose specifier resolves ONLY to a declaration file has no
// runtime module to link — Node throws ERR_MODULE_NOT_FOUND here, and a
// declaration file is not a program module (its own imports must never be
// lowered as code).
import { value } from "./types.js";

console.log(value);
