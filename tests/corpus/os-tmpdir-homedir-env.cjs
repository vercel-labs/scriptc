// os.tmpdir() and os.homedir() read the environment on every call:
// TMPDIR wins over TMP over TEMP, an empty value falls through, exactly
// one trailing slash is trimmed, and homedir answers HOME verbatim (an
// empty HOME stays the empty string). The environment is put back at the
// end.
const os = require("node:os");

// The program runs in its own process, so the variables are cleared again
// at the end rather than restored to whatever the test runner had set.

delete process.env.TMPDIR;
delete process.env.TMP;
delete process.env.TEMP;
console.log("fallback", os.tmpdir());

process.env.TMPDIR = "/custom/tmp/";
console.log("trailing slash", os.tmpdir());
process.env.TMPDIR = "/custom/tmp///";
console.log("three slashes", os.tmpdir());
process.env.TMPDIR = "/custom/tmp";
console.log("no slash", os.tmpdir());
process.env.TMPDIR = "";
console.log("empty TMPDIR", os.tmpdir());
process.env.TMPDIR = "relative/tmp";
console.log("relative", os.tmpdir());
process.env.TMPDIR = "/";
console.log("root", os.tmpdir());

delete process.env.TMPDIR;
process.env.TMP = "/tmp-from-tmp";
console.log("TMP", os.tmpdir());
process.env.TMPDIR = "/tmpdir-wins";
console.log("precedence", os.tmpdir());
delete process.env.TMPDIR;
process.env.TEMP = "/tmp-from-temp";
console.log("TEMP kept under TMP", os.tmpdir());
delete process.env.TMP;
console.log("TEMP", os.tmpdir());
delete process.env.TEMP;

process.env.HOME = "/custom/home/";
console.log("HOME trailing", os.homedir());
process.env.HOME = "/custom/home";
console.log("HOME plain", os.homedir());
process.env.HOME = "";
console.log("HOME empty", JSON.stringify(os.homedir()));

delete process.env.TMPDIR;
delete process.env.TMP;
delete process.env.TEMP;
delete process.env.HOME;
console.log("cleared tmpdir", os.tmpdir());
console.log("cleared home falls back to the passwd entry", os.homedir().length > 0);
