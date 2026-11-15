"""Run a readline terminal program on a PTY, type a line and stop the
process, then print the raw terminal output Base64.

The first argument is the mode. "listener" registers a 'SIGTSTP' listener
(the interface emits the event instead of stopping); "default" leaves the
process to stop on Ctrl+Z; "blocked" is "default" with SIGTSTP blocked in
the observer, so the program inherits the block across exec, as a program
started by a service manager or a CI runner can; "external" stops it with
a SIGTSTP from outside the process. For the modes that stop, the observer
waits for the stop, sends SIGCONT and expects the pause/'SIGCONT'/refresh
sequence; an external SIGCONT emits no 'SIGCONT' (Node only reports the
interface's own suspend). The remaining arguments are the command.
"""
import base64, json, os, pty, select, signal, subprocess, sys, termios, time

mode = sys.argv[1]
command = sys.argv[2:]
if mode == "listener":
    command = command + ["--listener"]
if mode == "blocked":
    # A blocked set survives exec. Node replaces the inherited set at startup
    # (src/node.cc, PlatformInit: an empty set, then SIGUSR1 blocked for its
    # inspector thread) and the runtime does the same, so the stop below has
    # to work with the mask this process was started with. The flow relies on
    # an inspector-enabled oracle to inherit the block at all; released Node
    # builds have the inspector.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTSTP})

master, slave = pty.openpty()
# The cooked terminal the program starts on: echo, canonical input and the
# Ctrl+Z signal. Node puts a terminal back in this mode when the process
# ends (libuv's uv_tty_reset_mode), so the program owes the same.
cooked = termios.ECHO | termios.ICANON | termios.ISIG
entry_mode = termios.tcgetattr(slave)[3] & cooked
# The program runs in a process group of its own. The kernel discards
# job-control stops (SIGTSTP, SIGTTIN, SIGTTOU) for a process in an
# orphaned group, and a harness that starts this script inside a session
# leader's group leaves the program in one: the stop that Ctrl+Z asks for
# is dropped, for Node and a compiled binary alike, and the program keeps
# running. A group of its own cannot be orphaned by that shape — its
# parent stays in the same session, in another group — so the stop always
# lands. os.setpgrp is what the child runs before it execs (one syscall, and
# no keyword that older Pythons lack).
proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=subprocess.PIPE,
                        preexec_fn=os.setpgrp)

seen = bytearray()


def read_until(needle, deadline, start=0):
    while needle not in bytes(seen[start:]) and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            chunk = os.read(master, 65536)
            if not chunk:
                break
            seen.extend(chunk)
    assert needle in bytes(seen[start:]), (needle, bytes(seen[start:]))


def drain():
    while select.select([master], [], [], 0.05)[0]:
        chunk = os.read(master, 65536)
        if not chunk:
            break
        seen.extend(chunk)


def wait_stopped(timeout=10):
    """The program's stop status. A stop that never comes fails here, with
    the reason, instead of holding the test until its own timeout."""
    end = time.monotonic() + timeout
    while True:
        pid, status = os.waitpid(proc.pid, os.WUNTRACED | os.WNOHANG)
        if pid != 0:
            return status
        assert time.monotonic() < end, f"the program did not suspend on SIGTSTP in {timeout}s"
        time.sleep(0.01)


deadline = time.monotonic() + 10
try:
    read_until(b"> ", deadline)
    os.write(master, b"abc")
    read_until(b"abc", deadline)
    if mode == "listener":
        os.write(master, b"\x1a")
        read_until(b"TSTP\r\n", deadline)
        os.write(master, b"\r")
        read_until(b"LINE abc", deadline)
    else:
        if mode == "external":
            os.kill(proc.pid, signal.SIGTSTP)
        else:
            os.write(master, b"\x1a")
        status = wait_stopped()
        assert os.WIFSTOPPED(status) and os.WSTOPSIG(status) == signal.SIGTSTP, (status,)
        os.kill(proc.pid, signal.SIGCONT)
        # The stop wait above may have used most of the first deadline.
        deadline = time.monotonic() + 10
        if mode == "external":
            time.sleep(0.5)
            drain()
            assert b"CONT" not in bytes(seen), bytes(seen)
            # The interface never paused, so the line typed now produces a
            # 'line' event, and the program closes the interface and ends.
            os.write(master, b"\r")
        else:
            # The resumed interface stays paused, so the program finishes on
            # its own. Typing here would race that exit: the pty echoes the
            # byte only once the program has restored the terminal, and
            # whether it has by then is a scheduling detail.
            read_until(b"PAUSE\r\nCONT\r\n", deadline)
            read_until(b"\x1b[1G\x1b[0J> abc", deadline)
    proc.wait(timeout=5)
    drain()
    # The shell that started the program gets its terminal back even when
    # the program ended while readline held raw mode.
    left = termios.tcgetattr(slave)[3] & cooked
    assert left == entry_mode, f"the program left the terminal in raw mode ({left:#x})"
    errors = proc.stderr.read().decode("utf-8", "replace")
    assert proc.returncode == 0 and not errors, (proc.returncode, errors)
    print(json.dumps({"out": base64.b64encode(bytes(seen)).decode("ascii")}))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    for fd in (master, slave):
        os.close(fd)
