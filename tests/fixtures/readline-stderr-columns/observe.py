"""Run a command with a pty of the given width on stderr, stdin from /dev/null,
and its stderr bytes as JSON."""
import fcntl, json, os, pty, select, struct, subprocess, sys, termios

width = int(sys.argv[1])
err_master, err_slave = pty.openpty()
fcntl.ioctl(err_slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, width, 0, 0))
proc = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err_slave)
os.close(err_slave)
errors = bytearray()
while True:
    if select.select([err_master], [], [], 0.1)[0]:
        try:
            data = os.read(err_master, 65536)
        except OSError:
            break
        if not data:
            break
        errors.extend(data)
    elif proc.poll() is not None:
        break
proc.wait()
out = proc.stdout.read()
os.close(err_master)
print(json.dumps({"stdout": out.decode('utf-8', 'replace'),
                  "stderr": errors.decode('utf-8', 'replace'),
                  "returncode": proc.returncode}))
