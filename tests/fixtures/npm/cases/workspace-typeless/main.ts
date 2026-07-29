// A workspace package whose realpath escapes node_modules and whose
// package.json omits "type": Node syntax-detects both .js modules as ESM
// and emits MODULE_TYPELESS_PACKAGE_JSON once for the package.
import { describe } from "wstypeless";

console.log(describe(21));
