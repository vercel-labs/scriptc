"""Run a readline terminal program on a PTY, type a line and stop the
process, then print the raw terminal output Base64.

The first argument is the mode. "listener" registers a 'SIGTSTP' listener
(the interface emits the event instead of stopping); "default" leaves the
process to stop on Ctrl+Z; "external" stops it with a SIGTSTP from outside
the process. For the two modes that stop, the observer waits for the stop,
sends SIGCONT and expects the pause/'SIGCONT'/refresh sequence; an external
SIGCONT emits no 'SIGCONT' (Node only reports the interface's own suspend).
The remaining arguments are the command.
"""
import base64, json, os, pty, select, signal, subprocess, sys, time

mode = sys.argv[1]
command = sys.argv[2:]
if mode == "listener":
    command = command + ["--listener"]

master, slave = pty.openpty()
proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=subprocess.PIPE)

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
        if mode == "default":
            os.write(master, b"\x1a")
        else:
            os.kill(proc.pid, signal.SIGTSTP)
        pid, status = os.waitpid(proc.pid, os.WUNTRACED)
        assert os.WIFSTOPPED(status) and os.WSTOPSIG(status) == signal.SIGTSTP, (status,)
        os.kill(proc.pid, signal.SIGCONT)
        if mode == "default":
            read_until(b"PAUSE\r\nCONT\r\n", deadline)
            read_until(b"\x1b[1G\x1b[0J> abc", deadline)
        else:
            time.sleep(0.5)
            drain()
            assert b"CONT" not in bytes(seen), bytes(seen)
        # The resumed interface stays paused, so the line typed now ends the
        # program's loop instead of producing a 'line' event.
        os.write(master, b"\r")
    proc.wait(timeout=5)
    drain()
    errors = proc.stderr.read().decode("utf-8", "replace")
    assert proc.returncode == 0 and not errors, (proc.returncode, errors)
    print(json.dumps({"out": base64.b64encode(bytes(seen)).decode("ascii")}))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    for fd in (master, slave):
        os.close(fd)
