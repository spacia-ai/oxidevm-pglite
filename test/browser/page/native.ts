import type { UserspaceVM } from "@oxidevm/sdk";
import type { SuiteConfig } from "./protocol";
import { python, run } from "./util";
import type { Run } from "./util";

/** Where the native clients are unpacked, and the environment that finds their libraries. */
export const CLIENTS = "/workspace/_oxidevm/clients";
export const CLIENT_ENV = { PYTHONPATH: `${CLIENTS}/python`, LD_LIBRARY_PATH: `${CLIENTS}/lib` };
export const POSTGRES_URL = "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable";

/** Imports the module's Python client, which the module wrote into the workspace. */
export const CLIENT_IMPORT = "import sys\nsys.path.insert(0, '/workspace/_oxidevm')\nimport oxidevm_pglite as pg\n";

/**
 * A program that sends one request to the JSON endpoint over a plain Linux socket, as any client in any language
 * would, and prints the reply object. `request` is a Python expression for the bytes to send after the header
 * (or the whole message when `raw` is true).
 */
export function rawExchange(request: string, options: { readonly raw?: boolean } = {}): string {
  return [
    "import json, socket, struct",
    "s = socket.socket(socket.AF_UNIX)",
    "s.settimeout(120)",
    "s.connect('/workspace/_oxidevm/pglite.sock')",
    `payload = ${request}`,
    options.raw === true ? "s.sendall(payload)" : "s.sendall(struct.pack('!I', len(payload)) + payload)",
    "header = b''",
    "while len(header) < 4:",
    "    chunk = s.recv(4 - len(header))",
    "    assert chunk, 'closed before the reply header'",
    "    header += chunk",
    "size = struct.unpack('!I', header)[0]",
    "data = b''",
    "while len(data) < size:",
    "    chunk = s.recv(min(65536, size - len(data)))",
    "    assert chunk, 'closed before the whole reply'",
    "    data += chunk",
    "print(json.dumps({'size': size, 'reply': json.loads(data)}))",
  ].join("\n");
}

/** The object `rawExchange` prints: how many bytes the reply was, and the reply itself. */
export function exchangeOf(output: string): { readonly size: number; readonly reply: unknown } {
  const parsed: unknown = JSON.parse(output);
  const size: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "size") : undefined;
  if (typeof size !== "number") throw new Error(`Not an exchange: ${output.slice(0, 200)}`);
  return { size, reply: Reflect.get(parsed ?? {}, "reply") };
}

/** A statement for `rawExchange`. */
export const sqlRequest = (sql: string, params = "[]"): string => `json.dumps({'sql': ${JSON.stringify(sql)}, 'params': ${params}}).encode()`;

/** Unpacks native psql (libpq 17) and psycopg 3 for the image's Python into the workspace. */
export async function installClients(vm: UserspaceVM, config: SuiteConfig): Promise<void> {
  const response = await fetch(config.clientsURL);
  if (!response.ok) throw new Error(`The native clients are not served (HTTP ${String(response.status)})`);
  await vm.workspace.writeFile("_oxidevm/postgres-clients.tar.gz", new Uint8Array(await response.arrayBuffer()));
  await python(vm, `import tarfile, os\nos.makedirs(${JSON.stringify(CLIENTS)}, exist_ok=True)\ntarfile.open('/workspace/_oxidevm/postgres-clients.tar.gz').extractall(${JSON.stringify(CLIENTS)}, filter='data')`);
}

const psqlArgs = (commands: readonly string[], output: readonly string[] = []): string[] =>
  [POSTGRES_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...output, ...commands.flatMap(command => ["-c", command])];

export async function psql(vm: UserspaceVM, ...commands: readonly string[]): Promise<string> {
  const result = await run(vm, { command: `${CLIENTS}/bin/psql`, args: psqlArgs(commands), env: CLIENT_ENV });
  if (result.status !== 0) throw new Error(`psql exited ${String(result.status)}: ${result.stderr.trim().slice(-1500)}`);
  return result.stdout.trim();
}

/** psql with its query output on /dev/null (`-o /dev/null`), which musl's stdio writes with `writev`. */
export function psqlToDevNull(vm: UserspaceVM, command: string): Promise<Run> {
  return run(vm, { command: `${CLIENTS}/bin/psql`, args: psqlArgs([command], ["-o", "/dev/null"]), env: CLIENT_ENV });
}

/** A 30 MB `write(2)` and a 30 MB `writev(2)` to /dev/null; Linux returns both whole. */
export const DEV_NULL_WRITES = String.raw`import os
fd = os.open('/dev/null', os.O_WRONLY)
print(os.write(fd, b'x' * 30_000_000), os.writev(fd, [b'x' * 20_000_000, b'y' * 10_000_000]))`;

/**
 * The psycopg session of the sample, unchanged in what it exercises: prepared statements, binary results, COPY in
 * both directions and in binary, an aborted COPY, a 2 MiB result, a failed statement, a connection that sits idle
 * for more than thirty seconds, and a client that disconnects while a large result is on its way.
 */
export const DRIVER = String.raw`import io, time, psycopg
URL = "${POSTGRES_URL}"
with psycopg.connect(URL) as conn:
    with conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS wire_data")
        cur.execute("CREATE TABLE wire_data(n integer, label text)")
        for value in range(8):
            cur.execute("SELECT %s::integer + 1", (value,), prepare=True)
            assert cur.fetchone() == (value + 1,)
        with conn.cursor(binary=True) as binary:
            binary.execute("SELECT %s::integer", (42,))
            assert binary.fetchone() == (42,)
        with cur.copy("COPY wire_data FROM STDIN") as copy:
            copy.write("1\tfirst\n2\tsecond\n")
        with cur.copy("COPY wire_data TO STDOUT") as copy:
            output = b"".join(copy)
            assert b"first" in output and b"second" in output
        with cur.copy("COPY wire_data FROM STDIN (FORMAT BINARY)") as copy:
            copy.set_types(["int4", "text"])
            copy.write_row((3, "binary"))
        conn.commit()
        try:
            with cur.copy("COPY wire_data FROM STDIN") as copy:
                copy.write_row((99, "aborted"))
                raise ValueError("abort this COPY")
        except ValueError:
            conn.rollback()
        cur.execute("SELECT count(*) FROM wire_data")
        assert cur.fetchone() == (3,)
        cur.execute("SELECT repeat('x', 2097152)")
        assert len(cur.fetchone()[0]) == 2097152
        cur.execute("SELECT repeat('x', 8388608)")
        assert len(cur.fetchone()[0]) == 8388608
    conn.commit()
    try:
        conn.execute("SELECT * FROM missing_wire_table")
    except psycopg.errors.UndefinedTable:
        conn.rollback()
    assert conn.execute("SELECT 42").fetchone() == (42,)
with psycopg.connect(URL, autocommit=True) as idle:
    open("/workspace/_oxidevm/pg-idle-ready", "w").write("ready")
    time.sleep(31)
    assert idle.execute("SELECT 42").fetchone() == (42,)
interrupted = psycopg.connect(URL, autocommit=True)
interrupted.pgconn.send_query(b"SELECT repeat('x', 2097152)")
interrupted.pgconn.flush()
interrupted.close()
with psycopg.connect(URL) as recovered:
    assert recovered.execute("SELECT 42").fetchone() == (42,)
print("PSYCOPG_EXTENDED_BINARY_COPY_LARGE_RECOVERY_OK")
`;

/** The frames of the PostgreSQL protocol a program needs to start a session and ask one question. */
const PROTOCOL = String.raw`import socket, struct
def message(kind, body=b''):
    return kind + struct.pack('!I', len(body) + 4) + body
def startup():
    body = struct.pack('!I', 196608) + b'user\x00postgres\x00database\x00postgres\x00\x00'
    return struct.pack('!I', len(body) + 4) + body
def read_until_ready(connection):
    data = b''
    while not data.endswith(b'Z\x00\x00\x00\x05I'):
        chunk = connection.recv(65536)
        assert chunk, 'closed before ReadyForQuery'
        data += chunk
    return data
def hang_up(connection):
    connection.close()
`;

/**
 * A native client that asks for a 30 MB result and closes at once, with nothing unread: the peer has closed cleanly, so
 * the module's first write is accepted and its second is answered with EPIPE (the SIGPIPE case).
 */
export const NATIVE_CLEAN_HANGUP = `${PROTOCOL}
gone = socket.create_connection(('127.0.0.1', 5432))
gone.settimeout(120)
gone.sendall(startup())
read_until_ready(gone)
gone.sendall(message(b'Q', b"SELECT repeat('x', 30000000)\\x00"))
hang_up(gone)
print('native client closed cleanly right after asking for a 30 MB result')
`;

/** A native client that asks for a 30 MB result, reads the beginning of it and hangs up. */
export const NATIVE_HANGUP = `${PROTOCOL}
hung = socket.create_connection(('127.0.0.1', 5432))
hung.settimeout(120)
hung.sendall(startup())
read_until_ready(hung)
hung.sendall(message(b'Q', b"SELECT repeat('x', 30000000)\\x00"))
head = hung.recv(65536)
assert head[:1] == b'T', head[:20]
hang_up(hung)
print('native client hung up after ' + str(len(head)) + ' bytes of a 30 MB result')
`;

/** JSON clients that send a request for a large reply and hang up before they read it. */
export const JSON_HANGUP = String.raw`import json, socket, struct
for attempt in range(5):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(60)
    s.connect('/workspace/_oxidevm/pglite.sock')
    body = json.dumps({'sql': "SELECT repeat('x', 900000) AS big", 'params': []}).encode()
    s.sendall(struct.pack('!I', len(body)) + body)
    s.close()
print('5 JSON clients hung up before reading their reply')
`;

/** A second client that keeps asking the JSON endpoint a question for a while and records how every request ended. */
export const JSON_POLL = String.raw`import json, socket, struct, time
outcomes = []
end = time.monotonic() + 40
while time.monotonic() < end:
    try:
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(60)
        s.connect('/workspace/_oxidevm/pglite.sock')
        body = json.dumps({'sql': 'SELECT 1 AS one', 'params': []}).encode()
        s.sendall(struct.pack('!I', len(body)) + body)
        header = b''
        while len(header) < 4:
            chunk = s.recv(4 - len(header))
            if not chunk:
                raise ConnectionError('closed before a reply')
            header += chunk
        size = struct.unpack('!I', header)[0]
        data = b''
        while len(data) < size:
            chunk = s.recv(size - len(data))
            if not chunk:
                raise ConnectionError('closed in the middle of a reply')
            data += chunk
        reply = json.loads(data)
        outcomes.append('ok' if reply.get('ok') else 'busy' if 'owns the database' in reply.get('error', '') else 'error: ' + reply.get('error', ''))
        s.close()
    except OSError as error:
        outcomes.append('connection-failed: ' + str(error))
    time.sleep(0.4)
print(json.dumps(outcomes))
`;

/**
 * The real psql, killed as soon as 4 MiB of a 200 MB COPY result have reached it, so that the module is in the middle
 * of streaming when the client disappears. psql writes to a file so that the test can see how much has arrived.
 */
export const PSQL_KILLED = String.raw`import os, subprocess, time
path = '/tmp/psql-killed.out'
output = open(path, 'wb')
client = subprocess.Popen(['${CLIENTS}/bin/psql', '${POSTGRES_URL}', '-X', '-q', '-c', "COPY (SELECT repeat('x', 1000) FROM generate_series(1, 200000)) TO STDOUT"], stdout=output, stderr=subprocess.PIPE)
deadline = time.monotonic() + 120
while os.path.getsize(path) < 4 * 1024 * 1024 and client.poll() is None and time.monotonic() < deadline:
    time.sleep(0.05)
receiving = client.poll() is None
received = os.path.getsize(path)
client.kill()
_, problem = client.communicate()
output.close()
os.unlink(path)
if receiving:
    print('psql was still receiving a 200 MB COPY result when it was killed (' + str(received) + ' bytes had arrived)')
else:
    print('psql had already exited with status ' + str(client.returncode) + ' after ' + str(received) + ' bytes: ' + problem.decode(errors='replace')[:300])
`;
