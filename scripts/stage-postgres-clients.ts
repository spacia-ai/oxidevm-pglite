// Stages the native PostgreSQL clients the real-engine tests run inside the guest: psql (libpq 17, from Alpine) and
// psycopg 3 for Python 3.12, built for musl in a container and packed with the libraries they need. The tarball is a
// test tool, never part of a release and never committed; test/postgres-clients.lock.json records what was staged.
//
//   node scripts/stage-postgres-clients.ts          (needs Docker and the network)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const image = "python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322";
const destination = join(root, ".cache/postgres-clients.tar.gz");

const script = String.raw`set -eu
apk add --no-cache postgresql17-client >/dev/null
python -m pip install --quiet --no-compile --target /tmp/clients/python 'psycopg[binary]==3.2.13'
mkdir -p /tmp/clients/lib /tmp/clients/bin
cp /usr/bin/psql /tmp/clients/bin/
ldd /usr/bin/psql | awk '/=> \// {print $3}' | xargs -I{} cp -L {} /tmp/clients/lib/
python - <<'PY'
import json, subprocess
from pathlib import Path
Path('/tmp/clients/versions.json').write_text(json.dumps({'psql': subprocess.check_output(['psql', '--version'], text=True).strip(), 'apk': subprocess.check_output(['apk', 'info', '-v', 'postgresql17-client'], text=True).strip(), 'psycopg': '3.2.13'}))
PY
tar -C /tmp/clients -czf - .
`;

await mkdir(dirname(destination), { recursive: true });
const child = spawn("docker", ["run", "--rm", "--platform", "linux/amd64", "--entrypoint", "/bin/sh", image, "-c", script], { stdio: ["ignore", "pipe", "inherit"] });
const exited = new Promise<void>((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", code => { if (code === 0) resolve(); else reject(new Error(`PostgreSQL client build failed: ${String(code)}`)); });
});
await Promise.all([pipeline(child.stdout, createWriteStream(`${destination}.partial`)), exited]);
await rename(`${destination}.partial`, destination);
const bytes = await readFile(destination);
const versions: unknown = JSON.parse(execFileSync("tar", ["-xOzf", destination, "./versions.json"], { encoding: "utf8" }));
await writeFile(join(root, "test/postgres-clients.lock.json"), `${JSON.stringify({ image, ...(typeof versions === "object" && versions !== null ? versions : {}), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }, null, 2)}\n`);
process.stdout.write(`Staged the native PostgreSQL clients at ${destination}\n`);
