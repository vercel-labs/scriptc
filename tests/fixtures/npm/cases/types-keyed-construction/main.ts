// A plain-JavaScript package typed by an @types package builds its result
// key by key (`var p = {}; p.id = id; ...`): the object crosses the
// declaration boundary with every field, including the declared fields
// whose keys are not identifiers.
import { loadProfile, type Profile } from "profilekit";

const p: Profile = loadProfile(7);
console.log(p["a;b"].toUpperCase(), p["a;b"].length);
console.log(p["my-key"], p["my-key"].length, p["x y"].length);
console.log(p.id, p.count, JSON.stringify(p));
const keys: string[] = Object.keys(p);
console.log(keys.join("|"));
