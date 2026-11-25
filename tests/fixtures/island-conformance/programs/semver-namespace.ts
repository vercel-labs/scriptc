import * as semver from "semver";

const versions = ["1.2.3", "1.4.0", "2.0.0-beta.1", "2.0.0", "0.9.9"];
console.log(semver.satisfies("1.2.3", "^1.0.0"), semver.satisfies("2.0.0-beta.1", "^2.0.0"));
console.log(semver.maxSatisfying(versions, "^1.0.0"), semver.minSatisfying(versions, ">=1.3"));
console.log(versions.slice().sort(semver.compare).join(" "));
console.log(semver.coerce("v2")?.version, semver.inc("1.2.3", "minor"), semver.valid("not-a-version"));
console.log(new semver.Range(">=1.2.0 <2.0.0").test("1.9.9"), semver.diff("1.2.3", "1.3.0"));
