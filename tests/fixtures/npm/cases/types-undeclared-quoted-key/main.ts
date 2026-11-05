// A package typed from its JavaScript returns profiles without a key its
// declarations promise ("a;b"). A literal-key read of that key answers
// undefined, as Node's does; it never reads another field.
import { loadProfiles } from "hostilekit";

const profiles = loadProfiles();
for (const p of profiles) {
  console.log(p.id, p["a;b"] === undefined, typeof p["a;b"], "a;b" in p);
  try {
    console.log(p["a;b"].toUpperCase());
  } catch (e) {
    console.log("upper threw", e instanceof TypeError);
  }
  try {
    console.log(p["a;b"].length);
  } catch (e) {
    console.log("length threw", e instanceof TypeError);
  }
  console.log(p.id.toFixed(1), JSON.stringify(p));
}
