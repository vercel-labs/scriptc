import { builtinDefaultImportModule, canonicalBuiltinModule, SUPPORTED_NODE_MODULES, unsupportedModuleFeatureOf } from "../../../packages/compiler/src/frontend/builtin-modules.js";
import { isNodeModulesPath } from "../../../packages/compiler/src/frontend/resolve.js";
import { clearWorkspacePackages, isWorkspacePackageName, npmPackageNameOf, packageNameOfSpecifier, registerWorkspacePackage, workspacePackageOfPath } from "../../../packages/compiler/src/frontend/workspace-registry.js";
import { isNpmStaticPackage, npmStaticActive, npmStaticOffenders, npmStaticPackageOfPath, reportNpmStaticOffender, setNpmStaticPackages } from "../../../packages/compiler/src/frontend/npm-static.js";

// Execute production frontend registries and classification paths. Their
// module initializers and generic calls are part of the compiled program.
for (const specifier of SUPPORTED_NODE_MODULES) {
  console.log(specifier, canonicalBuiltinModule(specifier), builtinDefaultImportModule(specifier));
}
for (const specifier of ["test", "node:test", "node:missing", "missing", "vm", "node:inspector", "graceful-fs", "node:graceful-fs"]) {
  console.log(canonicalBuiltinModule(specifier), unsupportedModuleFeatureOf(specifier));
}
clearWorkspacePackages();
registerWorkspacePackage("@compiler/first", "/repo/packages/first");
registerWorkspacePackage("@compiler/second", "C:\\repo\\packages\\second");
setNpmStaticPackages(["@compiler/first", "left", "@scope/right"]);
console.log(npmStaticActive(), isNpmStaticPackage(null), isNpmStaticPackage("left"));
for (const path of [
  "/repo/packages/first/index.ts",
  "/repo/packages/first-extra/index.ts",
  "C:\\repo\\packages\\second\\index.ts",
  "/repo/node_modules/left/index.js",
  "/repo/node_modules/left/node_modules/@scope/right/index.js",
  "/repo/node_modules/unknown/index.js",
  "/repo/node_modules-extra/left/index.js",
  "node_modules/left/index.js",
]) {
  console.log(path, isNodeModulesPath(path), npmPackageNameOf(path), workspacePackageOfPath(path), npmStaticPackageOfPath(path));
}
console.log(isWorkspacePackageName("@compiler/first"), isWorkspacePackageName("missing"));
for (const specifier of ["left", "left/sub/path", "@scope/right", "@scope/right/sub"]) console.log(packageNameOfSpecifier(specifier));
reportNpmStaticOffender("left", "first reason");
reportNpmStaticOffender("left", "ignored reason");
reportNpmStaticOffender("unknown", "not selected");
reportNpmStaticOffender("@scope/right", "second reason");
const saved = new Map(npmStaticOffenders());
console.log(JSON.stringify([...saved]));
setNpmStaticPackages(new Set(["@compiler/second"]));
console.log(npmStaticOffenders().size, saved.size, npmStaticActive());
console.log(isNpmStaticPackage("left"), npmStaticPackageOfPath("C:\\repo\\packages\\second\\index.ts"));
clearWorkspacePackages();
console.log(npmStaticPackageOfPath("C:\\repo\\packages\\second\\index.ts"));
setNpmStaticPackages([] as string[]);
console.log(npmStaticActive(), npmStaticOffenders().size);
