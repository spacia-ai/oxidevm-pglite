"""Writes PostgreSQL responses to a client socket for the PGlite module.

A JavaScript write to a socket whose client has gone ends the writing process (SIGPIPE), which would end the
module. This helper writes in its place: Python ignores SIGPIPE, so it reports the failure instead. (Phase 1:
the helper is removed when engine API 144 lands.)

The module starts it with the client's socket as its standard output. It spools a response into the file named
on the command line and writes "send" on this helper's standard input; the helper copies the file to the socket
and answers on standard error with one JSON line:

    {"ok":true}   or   {"ok":false,"error":"..."}

After the first failure every later send fails at once. The helper exits when its standard input ends.
"""
import json
import os
import sys

CHUNK = 65536


def send(path, disconnected):
    if disconnected:
        raise BrokenPipeError("PostgreSQL client disconnected")
    with open(path, "rb", buffering=0) as source:
        while True:
            chunk = source.read(CHUNK)
            if not chunk:
                return
            view = memoryview(chunk)
            while len(view) > 0:
                count = os.write(1, view)
                if count == 0:
                    raise BrokenPipeError("Socket write made no progress")
                view = view[count:]


def main():
    path = sys.argv[1]
    disconnected = False
    for command in sys.stdin.buffer:
        try:
            if command != b"send\n":
                raise ValueError("Invalid response writer command")
            send(path, disconnected)
            reply = {"ok": True}
        except Exception as error:  # any failure means the client can no longer be served
            disconnected = True
            reply = {"ok": False, "error": str(error)}
        sys.stderr.write(json.dumps(reply) + "\n")
        sys.stderr.flush()


main()
