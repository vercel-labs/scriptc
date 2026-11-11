"""Run a program on two terminals and resize both after each of its first two lines."""
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

out_master, out_slave = pty.openpty()
err_master, err_slave = pty.openpty()
def resize(fd, columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))

resize(out_slave, 90, 40)
resize(err_slave, 70, 20)
steps = [((101, 41), (81, 21)), ((102, 42), (82, 22))]
proc = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=out_slave, stderr=err_slave)
pending = b''
errors = bytearray()
lines = []
deadline = time.monotonic() + 10
try:
    while len(lines) < 4 and time.monotonic() < deadline:
        for fd in select.select([out_master, err_master], [], [], 0.05)[0]:
            data = os.read(fd, 65536)
            if fd == err_master:
                errors.extend(data)
                continue
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                lines.append(json.loads(line))
                if len(lines) <= len(steps):
                    out_size, err_size = steps[len(lines) - 1]
                    resize(out_slave, *out_size)
                    resize(err_slave, *err_size)
                    os.kill(proc.pid, signal.SIGWINCH)
    proc.wait(timeout=3)
    while select.select([err_master], [], [], 0)[0]:
        errors.extend(os.read(err_master, 65536))
    assert proc.returncode == 0 and not errors, (proc.returncode, errors, lines)
    print(json.dumps(lines))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    for fd in [out_master, out_slave, err_master, err_slave]: os.close(fd)
