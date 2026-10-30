// A terminal package that loads prebuilt native helpers the way pi-tui does:
// it builds candidate paths (through require.resolve read as a value) and
// requires each one inside a try block. On Linux without DISPLAY the
// clipboard helper is never loaded, and on other platforms no helper for
// the platform is installed, so the package uses its JavaScript fallback as
// in Node.
import { getNativeClipboard, getNativeModuleCandidates, isNativeModifierPressed } from "native-helper";
import { relative } from "node:path";

delete process.env["DISPLAY"];
console.log("clipboard", typeof getNativeClipboard());
console.log("modifier", isNativeModifierPressed("shift"));
const root = import.meta.dirname;
for (const candidate of getNativeModuleCandidates("native/helper.node")) {
  console.log("candidate", relative(root, candidate).replaceAll("\\", "/"));
}
const custom = getNativeModuleCandidates("native/helper.node", { resolvePackage: () => "/opt/helper/dist/index.js" });
console.log("custom", custom[0]!.replaceAll("\\", "/"));
