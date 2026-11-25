"""Run a program with stdout and stderr on terminals, in exactly the environment given as NAME=value arguments
before `--`, and print what it wrote as JSON."""
import json, os, pty, select, subprocess, sys, time

split = sys.argv.index('--')
env = {'PATH': os.environ.get('PATH', '')}
for pair in sys.argv[1:split]:
    name, _, value = pair.partition('=')
    env[name] = value
for name in ('MallocNanoZone', 'ASAN_OPTIONS', 'LSAN_OPTIONS', 'UBSAN_OPTIONS'):
    if name in os.environ:
        env[name] = os.environ[name]
out_master, out_slave = pty.openpty()
err_master, err_slave = pty.openpty()
proc = subprocess.Popen(sys.argv[split + 1:], stdin=subprocess.DEVNULL, stdout=out_slave, stderr=err_slave, env=env)
written = {out_master: bytearray(), err_master: bytearray()}
deadline = time.monotonic() + 30
try:
    while time.monotonic() < deadline:
        ready = select.select([out_master, err_master], [], [], 0.05)[0]
        for fd in ready:
            written[fd].extend(os.read(fd, 65536))
        if not ready and proc.poll() is not None:
            break
    status = proc.wait(timeout=3)
    text = lambda fd: written[fd].decode('utf-8', 'replace').replace('\r\n', '\n')
    print(json.dumps({'status': status, 'stdout': text(out_master), 'stderr': text(err_master)}))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    for fd in [out_master, out_slave, err_master, err_slave]:
        os.close(fd)
