"""Run a command with stdout on one PTY and report every byte it wrote."""
import base64, json, os, pty, select, subprocess, sys

out_master, out_slave = pty.openpty()
proc = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=out_slave, stderr=subprocess.PIPE)
os.close(out_slave)
data = bytearray()
while True:
    ready = select.select([out_master], [], [], 5)[0]
    if not ready:
        break
    try:
        chunk = os.read(out_master, 65536)
    except OSError:
        break
    if not chunk:
        break
    data.extend(chunk)
err = proc.stderr.read()
proc.wait(timeout=5)
os.close(out_master)
print(json.dumps({"out": base64.b64encode(bytes(data)).decode(), "code": proc.returncode, "err": err.decode("utf-8", "replace")}))
