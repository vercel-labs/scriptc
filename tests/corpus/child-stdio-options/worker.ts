// An idle fork target: the empty body lets the child exit on its own, which
// is what the stdio matrix's last fork observes.
process.exitCode = 0;
