// @requires-libnode
// Process state is one state: environment variables, the working directory
// and the umask changed by one side are what the other reads.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.env.STRESS_A = "native-set";
log(`island reads ${lib.env("STRESS_A")}`);
lib.setEnv("STRESS_B", "island-set");
log(`native reads ${process.env.STRESS_B}`);
delete process.env.STRESS_B;
log(`island reads after native delete ${lib.env("STRESS_B")}`);
lib.delEnv("STRESS_A");
log(`native reads after island delete ${process.env.STRESS_A}`);
const start = process.cwd();
process.chdir("/tmp");
log(`island cwd ${lib.cwd()}`);
lib.chdir("/");
log(`native cwd ${process.cwd()}`);
process.chdir(start);
log(`same cwd ${lib.cwd() === start}`);
log(`argv ${process.argv.slice(2).join(",")} | ${lib.argv()}`);
log(`pid same ${lib.pid() === process.pid}`);
const old = process.umask(0o27);
log(`island umask ${lib.umask().toString(8)}`);
lib.setUmask(0o77);
log(`native umask ${process.umask().toString(8)}`);
process.umask(old);
log(`tty ${process.stdout.isTTY} ${process.stderr.isTTY} ${process.stdin.isTTY} | ${lib.isTTY()}`);
