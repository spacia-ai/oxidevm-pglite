"""Python client for the SQL endpoint of the OxideVM PGlite module (protocol oxidevm-sql/1).

    import oxidevm_pglite

    result = oxidevm_pglite.query("SELECT $1::int + 1 AS next", [41])
    result["rows"]       # [{"next": 42}]

The module listens on a Unix socket in the workspace. Under Pyodide the connection comes from the OxideVM bridge
(`oxidevm.connect_unix`, a blocking socket-like object with sendall, recv and close); with a Linux Python it is an
ordinary socket. One request is one connection: a 4-byte big-endian length, then a JSON object
{"sql": ..., "params": [...]}; the reply has the same framing and is {"ok": true, "result": {...}} or
{"ok": false, "error": "..."}. A request is at most 64 KiB and a reply at most 1 MiB.

For COPY, prepared statements and transactions that span calls, connect a native PostgreSQL client to
127.0.0.1:5432 instead (user and database "postgres"); while a native connection runs a statement or has a
transaction open, query() waits a moment and then raises PGliteError.
"""
import json
import socket
import struct
import time

try:  # Pyodide: the OxideVM bridge provides the socket.
    import oxidevm as _bridge

    _connect_unix = _bridge.connect_unix
except (ImportError, AttributeError):  # a Linux Python: use the socket module.
    _connect_unix = None

__all__ = ["SOCKET_PATH", "PGliteError", "query"]

SOCKET_PATH = "/workspace/_oxidevm/pglite.sock"
MAX_REQUEST = 64 * 1024
MAX_REPLY = 1024 * 1024
TIMEOUT = 30.0


class PGliteError(RuntimeError):
    """The database refused or failed the statement, or the module did not answer properly."""


def _open(path, timeout):
    if _connect_unix is not None:
        return _connect_unix(path)
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(timeout)
        connection.connect(path)
    except BaseException:
        connection.close()
        raise
    return connection


def _read_exactly(connection, size, deadline):
    chunks = []
    remaining = size
    while remaining > 0:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("PGlite did not answer in time")
        settimeout = getattr(connection, "settimeout", None)
        if settimeout is not None:
            settimeout(left)
        chunk = connection.recv(min(remaining, 65536))
        if not chunk:
            raise PGliteError("PGlite closed the connection before it replied")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def query(sql, params=None, *, path=SOCKET_PATH, timeout=TIMEOUT):
    """Runs one statement and returns PGlite's result: rows, fields, affectedRows, command, rowCount, pid, backend.

    `params` fill $1, $2, ... Raises PGliteError (a RuntimeError) when the statement fails.
    """
    if not isinstance(sql, str) or (params is not None and not isinstance(params, (list, tuple))):
        raise TypeError("query expects SQL text and a parameter list")
    request = {"sql": sql, "params": [] if params is None else list(params)}
    body = json.dumps(request, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(body) > MAX_REQUEST:
        raise ValueError("Database request exceeds 64 KiB")
    deadline = time.monotonic() + timeout
    connection = _open(path, timeout)
    try:
        connection.sendall(struct.pack(">I", len(body)) + body)
        (length,) = struct.unpack(">I", _read_exactly(connection, 4, deadline))
        if length > MAX_REPLY:
            raise PGliteError("PGlite reply exceeds 1 MiB")
        reply = json.loads(_read_exactly(connection, length, deadline))
    finally:
        connection.close()
    if not isinstance(reply, dict) or not isinstance(reply.get("ok"), bool):
        raise PGliteError("PGlite sent an invalid reply")
    if not reply["ok"]:
        raise PGliteError(reply.get("error", "PGlite reported a failure"))
    return reply["result"]
