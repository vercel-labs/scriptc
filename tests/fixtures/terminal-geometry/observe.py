"""Give stdout/stderr independent dimensions, then resize both live TTYs."""
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

out_master, out_slave = pty.openpty()
err_master, err_slave = pty.openpty()
def resize(fd, columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))

resize(out_slave, 88, 48)
resize(err_slave, 72, 30)
proc = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=out_slave, stderr=err_slave)
pending = b''
errors = bytearray()
lines = []
deadline = time.monotonic() + 10
try:
    while len(lines) < 2 and time.monotonic() < deadline:
        for fd in select.select([out_master, err_master], [], [], 0.05)[0]:
            data = os.read(fd, 65536)
            if fd == err_master:
                errors.extend(data)
                continue
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                lines.append(json.loads(line))
                if len(lines) == 1:
                    assert lines[0] == [88, 48, 72, 30], lines
                    resize(out_slave, 100, 52)
                    resize(err_slave, 80, 24)
                    # Node refreshes its cached properties on SIGWINCH.
                    os.kill(proc.pid, signal.SIGWINCH)
    proc.wait(timeout=3)
    while select.select([err_master], [], [], 0)[0]:
        errors.extend(os.read(err_master, 65536))
    assert proc.returncode == 0 and not errors, (proc.returncode, errors)
    assert lines == [[88, 48, 72, 30], [100, 52, 80, 24]], lines
    print(json.dumps(lines))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    for fd in [out_master, out_slave, err_master, err_slave]: os.close(fd)
