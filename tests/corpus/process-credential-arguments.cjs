// The POSIX credential setters process.setuid/seteuid/setgid/setegid,
// setgroups and initgroups: Node's argument ladder and error objects, the
// 4294967295 sentinel that names an unknown credential, and the round trips
// that a process may make to its own credentials. Nothing here needs a
// privileged process: every call either validates, fails a name lookup, or
// re-selects the ids the program already has.
function attempt(label, fn) {
  try {
    const value = fn();
    console.log(label, "->", value === undefined ? "undefined" : value);
  } catch (error) {
    console.log(label, "|", error.constructor.name, error.code, "|", error.message);
  }
}

const uid = process.getuid();
const euid = process.geteuid();
const gid = process.getgid();
const egid = process.getegid();
console.log("current", uid, euid, gid, egid, uid === euid, gid === egid);

// Re-selecting the ids the process already has succeeds on every account.
attempt("setuid-self", () => process.setuid(uid));
attempt("seteuid-self", () => process.seteuid(euid));
attempt("setgid-self", () => process.setgid(gid));
attempt("setegid-self", () => process.setegid(egid));

// A name that does not resolve, and the sentinel a numeric (uid_t)-1
// becomes, answer ERR_UNKNOWN_CREDENTIAL with the id as it was passed.
attempt("setuid-unknown-name", () => process.setuid("scriptc-no-such-user"));
attempt("seteuid-unknown-name", () => process.seteuid("scriptc-no-such-user"));
attempt("setgid-unknown-name", () => process.setgid("scriptc-no-such-group"));
attempt("setegid-unknown-name", () => process.setegid("scriptc-no-such-group"));
attempt("setuid-sentinel", () => process.setuid(4294967295));
attempt("seteuid-sentinel", () => process.seteuid(4294967295));
attempt("setgid-sentinel", () => process.setgid(4294967295));
attempt("setegid-sentinel", () => process.setegid(4294967295));

// The numeric ladder: an integer in [0, 4294967295], else a RangeError;
// anything that is neither a number nor a string is a TypeError.
attempt("setuid-negative", () => process.setuid(-1));
attempt("setuid-fraction", () => process.setuid(1.5));
attempt("setuid-nan", () => process.setuid(NaN));
attempt("setuid-infinity", () => process.setuid(Infinity));
attempt("setuid-safe-integer-overflow", () => process.setuid(2 ** 53));
attempt("setgid-negative", () => process.setgid(-2));
attempt("setgid-fraction", () => process.setgid(2.5));
attempt("setegid-fraction", () => process.setegid(0.5));
attempt("seteuid-nan", () => process.seteuid(NaN));
attempt("setuid-boolean", () => process.setuid(true));
attempt("setuid-null", () => process.setuid(null));
attempt("setuid-undefined", () => process.setuid(undefined));
attempt("setuid-object", () => process.setuid({ id: uid }));
attempt("setgid-array", () => process.setgid([gid]));

// setgroups takes an array, validates every element as an id before the
// lookup, and names the offending element by index.
attempt("setgroups-string", () => process.setgroups("not-an-array"));
attempt("setgroups-object", () => process.setgroups({ 0: gid, length: 1 }));
attempt("setgroups-unknown", () => process.setgroups(["scriptc-no-such-group"]));
attempt("setgroups-unknown-second", () => process.setgroups([gid, "scriptc-no-such-group"]));
attempt("setgroups-unknown-third", () =>
  process.setgroups([gid, egid, "scriptc-no-such-group"]),
);
attempt("setgroups-sentinel", () => process.setgroups([4294967295]));
attempt("setgroups-empty-name", () => process.setgroups([""]));
attempt("setgroups-boolean-element", () => process.setgroups([gid, true]));
attempt("setgroups-object-element", () => process.setgroups([gid, {}]));
attempt("setgroups-fraction-element", () => process.setgroups([gid, 1.5]));
attempt("setgroups-negative-element", () => process.setgroups([-1]));

// initgroups validates both ids and answers the unknown credential for the
// numeric user the sentinel names or for the extra group's lookup.
attempt("initgroups-unknown-user", () => process.initgroups(4294967295, gid));
attempt("initgroups-unknown-group", () => process.initgroups(uid, 4294967295));
attempt("initgroups-unknown-group-name", () =>
  process.initgroups(uid, "scriptc-no-such-group"),
);
attempt("initgroups-user-fraction", () => process.initgroups(1.5, gid));
attempt("initgroups-group-fraction", () => process.initgroups(uid, 1.5));
attempt("initgroups-user-boolean", () => process.initgroups(false, gid));
attempt("initgroups-group-object", () => process.initgroups(uid, {}));

// None of the refused calls changed the process's credentials.
console.log(
  "unchanged",
  process.getuid() === uid,
  process.geteuid() === euid,
  process.getgid() === gid,
  process.getegid() === egid,
);
