#!/usr/bin/env python3
# Runs a login command in a pseudo-terminal for the setup wizard: python3 -I login-pty.py <log> <cmd...>
# Output is appended to <log>. Lines from stdin are typed into the terminal. Cursor-position and
# background-color queries get an answer (gh waits for them). The terminal is 400 columns wide so
# sign-in addresses stay on one line. Exits with the command's status.
import os, pty, select, struct, sys, fcntl, termios

log, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 400, 0, 0))
# Claude prints its token here: the log is the owner's alone.
with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "ab", buffering=0) as out:
    os.fchmod(out.fileno(), 0o600)
    while True:
        r, _, _ = select.select([fd, sys.stdin.fileno()], [], [], 1.0)
        if fd in r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out.write(chunk)
            if b"\x1b[6n" in chunk:
                os.write(fd, b"\x1b[1;1R")
            if b"\x1b]11;?" in chunk:
                os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        if sys.stdin.fileno() in r:
            line = os.read(sys.stdin.fileno(), 4096)
            if line:
                os.write(fd, line)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
