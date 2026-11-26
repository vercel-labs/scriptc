// process.getuid and the other POSIX credential readers as values. Node
// defines them only on POSIX, so the value is a function there and undefined
// on Windows; @types/node spells every one optional for that reason. Reading
// one as a value must answer the same function direct calls use.
const caseOf = (name: string, reader: (() => number) | undefined): string => {
  if (reader === undefined) return name + " absent";
  const value = reader();
  return name + " " + typeof reader + " " + reader.name + " " + reader.length + " " + (value > 0);
};
console.log(caseOf("getuid", process.getuid));
console.log(caseOf("getgid", process.getgid));
console.log(caseOf("geteuid", process.geteuid));
console.log(caseOf("getegid", process.getegid));
const groups = process.getgroups;
console.log(groups === undefined ? "getgroups absent" : "getgroups " + Array.isArray(groups()));

// The idiom the value read exists for: fall back when the member is absent.
const uid = process.getuid ? process.getuid() : 501;
const gid = process.getgid ? process.getgid() : 501;
console.log("fallback", uid > 0 || uid === 501, gid > 0 || gid === 501);

// One function identity per read, and the optional call still reaches the
// same reader.
const held = process.getuid;
console.log("identity", held === process.getuid, process.getuid === undefined);
console.log("held", held ? held() === uid : uid === 501);
console.log("optional", process.getuid?.() === uid);
if (process.geteuid) console.log("effective", process.geteuid() === process.geteuid());
