// `import * as constants from "node:constants"` binds the ES module
// namespace: the CommonJS object's own enumerable names plus "default",
// sorted by code unit, on a null-prototype object with no inherited
// members. The names themselves come from the platform's headers, so the
// compiler asks the loaded module instead of a census taken elsewhere.
import * as constants from "node:constants";

const keys = Object.keys(constants);
const names = Object.getOwnPropertyNames(constants);
console.log(Object.getPrototypeOf(constants) === null);
console.log("hasOwnProperty" in constants, "default" in constants, "toString" in constants);
console.log("O_RDONLY" in constants, "NOT_A_CONSTANT" in constants);
console.log(names.includes("default"), keys.includes("default"));
console.log(Object.prototype.hasOwnProperty.call(constants, "default"));
console.log(keys.join(",") === [...keys].sort().join(","));
console.log(keys.length === names.length, keys.length > 0);
console.log(keys.indexOf("default") > keys.indexOf("X_OK"), keys[keys.length - 1]);
console.log(constants.O_RDONLY, constants.X_OK, typeof constants.defaultCoreCipherList);

// A dynamic import resolves the same namespace object, so reflection over it
// answers the same member surface.
const dynamic = await import("node:constants");
const dynamicKeys = Object.keys(dynamic);
console.log("default" in dynamic, "toString" in dynamic, dynamicKeys.includes("default"));
console.log(dynamicKeys.join(",") === [...dynamicKeys].sort().join(","));
console.log(dynamic.O_RDONLY, typeof dynamic.default);

// The reflection reads the import call itself the same way.
console.log("O_RDONLY" in (await import("node:constants")));
console.log(Object.keys(await import("node:constants")).includes("default"));


