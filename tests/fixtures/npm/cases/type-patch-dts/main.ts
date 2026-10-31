// A package whose .d.ts says `email: string` for a value that is missing,
// patched to `string | undefined` (package.json scriptc.typePatches): the
// profiles cross the declaration boundary as native records, and user
// code handles the missing email the patched type now makes visible.
import { findProfile, loadProfiles } from "profilekit";

const profiles = loadProfiles();
for (const p of profiles) console.log(p.id, p.name, p.email ?? "(no email)", "email" in p);
console.log(JSON.stringify(profiles));
const emails = profiles.filter((p) => p.email !== undefined).map((p) => p.email!.toUpperCase());
console.log(emails.join(","));
const found = findProfile(3);
console.log(found === undefined ? "none" : found.name);
const missing = findProfile(9);
console.log(missing === undefined ? "none" : missing.name);
