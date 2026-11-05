// A package typed from its JavaScript returns profiles without a key its
// declarations promise ("a;b"). An optional read of that key answers
// undefined for a profile, and for a missing one (the chain reads the
// nullish receiver as undefined), in presence tests and in values.
const { loadProfiles } = require("hostilekit");
const profiles = loadProfiles();
const present = profiles[0];
const missing = profiles[5];
console.log(present?.["a;b"] === undefined, present?.["a;b"] ?? "none", typeof present?.["a;b"]);
console.log(missing?.["a;b"] === undefined, missing?.["a;b"] ?? "none", typeof missing?.["a;b"]);
console.log(present["a;b"] === undefined, present.id);
