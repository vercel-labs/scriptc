"""Run a readline terminal program on a PTY, type a line, narrow the
terminal and send SIGWINCH, then print the raw terminal output Base64."""
import base64, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

master, slave = pty.openpty()
def resize(columns, rows):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
resize(80, 24)
proc = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=subprocess.PIPE)

seen = bytearray()
def read_until(needle, deadline, start=0):
    while needle not in seen[start:] and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            seen.extend(os.read(master, 65536))
    assert needle in seen[start:], (needle, bytes(seen))

deadline = time.monotonic() + 10
try:
    read_until(b'> ', deadline)
    os.write(master, b'abc')
    read_until(b'abc', deadline)
    resize(4, 24)
    os.kill(proc.pid, signal.SIGWINCH)
    read_until(b'\x1b[0J> abc', deadline, len(seen))
    os.write(master, b'\r')
    read_until(b'LINE abc', deadline)
    proc.wait(timeout=5)
    while select.select([master], [], [], 0)[0]:
        seen.extend(os.read(master, 65536))
    errors = proc.stderr.read().decode('utf-8', 'replace')
    assert proc.returncode == 0 and not errors, (proc.returncode, errors)
    print(json.dumps({"out": base64.b64encode(bytes(seen)).decode("ascii")}))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    for fd in (master, slave): os.close(fd)
