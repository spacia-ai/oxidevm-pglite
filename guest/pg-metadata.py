"""Sets file times for the PGlite module.

The host's file operations have no utimes yet, so the module asks this helper to apply it (the helper is
removed when engine API 144 lands). It answers every request line with one reply line on standard output:

    request  {"op":"utimes","path":"/workspace/pgdata/base/1","atimeMs":1700000000000,"mtimeMs":1700000000000}
    reply    {"ok":true}   or   {"ok":false,"errno":13,"error":"Permission denied"}

Only paths inside the directories named on the command line are touched. The helper exits when its
standard input ends.
"""
import json
import math
import os
import sys

MAX_LINE = 4096
KEYS = {"op", "path", "atimeMs", "mtimeMs"}


def milliseconds(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(name + " must be a finite number of milliseconds")
    return value


def inside(path, roots):
    resolved = os.path.realpath(path)
    return any(resolved == root or resolved.startswith(root + "/") for root in roots)


def handle(line, roots):
    if len(line) > MAX_LINE:
        raise ValueError("Metadata request exceeds 4096 bytes")
    request = json.loads(line)
    if not isinstance(request, dict) or set(request) != KEYS or request["op"] != "utimes":
        raise ValueError("Unknown metadata request")
    path = request["path"]
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise ValueError("Metadata path must be absolute")
    if not inside(path, roots):
        raise ValueError("Metadata path is outside the database")
    accessed = milliseconds(request["atimeMs"], "atimeMs")
    modified = milliseconds(request["mtimeMs"], "mtimeMs")
    os.utime(path, ns=(int(accessed * 1000000), int(modified * 1000000)))


def main():
    roots = [os.path.realpath(root) for root in sys.argv[1:]]
    for line in sys.stdin.buffer:
        try:
            handle(line, roots)
            reply = {"ok": True}
        except OSError as error:
            reply = {"ok": False, "errno": error.errno or 5, "error": str(error)}
        except Exception as error:  # a malformed request must not stop the helper
            reply = {"ok": False, "errno": 22, "error": str(error)}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


main()
