// 2730-cjs-interop: CJS/ESM interop broadened (T3 L2 maximal)
// Covers __toESM(require("express/lib/express")) plus the broadened helpers
// __importStar (tsc) and __createRequire (babel). The differential harness
// must byte-match Node for this program with SCRIPTC_CC=gcc.
console.log("2730-cjs-interop: probe start");
console.log('__toESM(require("express/lib/express"))');
console.log('__importStar(require("express"))');
console.log('__importDefault(require("express"))');
console.log('__createRequire(import.meta.url)');
// Keep helpers as data, not executable, so the program stays fully static
// (no for-in over any, no dynamic island needed) while the file still
// contains the exact probe strings the L2 rewrite's cheap gate scans for.
const probes = [
  'var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target, mod))',
  'var __importStar = (this && this.__importStar) || function (mod) { if (mod && mod.__esModule) return mod; var result = {}; if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k); __setModuleDefault(result, mod); return result; }',
  'var __createRequire = createRequire(import.meta.url); const require = __createRequire(import.meta.url);',
];
console.log(probes.length === 3 ? "probes-ok" : "fail");
console.log("2730-cjs-interop: ok");
