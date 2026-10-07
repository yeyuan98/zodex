# Worked workspace-runtime examples

Three end-to-end walkthroughs: a full install on a network-restricted machine, an update, and
a teardown. Values are filled in where a real run would have measured them; the command shapes
are the ones from `patterns.md`.

---

## 1. Full install — Linux, no system node/uv, slow official sources

A workspace at `/home/me/proj` has an MCP server configured as `npx -y @upstash/context7-mcp`;
it fails with `runtime_unavailable`. No `node` or `uvx` on PATH. The user is on a mainland-China
network: official sources respond, but slowly.

**Step 1 — probe** (first run, so the probe version is the built-in known-good tag
`v22.14.0`):

```text
{candidate: nodejs.org/dist, httpCode: 206, latencyMs: 1840, ok: true}
{candidate: registry.npmmirror.com/-/binary/node, httpCode: 206, latencyMs: 430, ok: true}
{candidate: tuna/nodejs-release, httpCode: 206, latencyMs: 295, ok: true}
```

Similar sweeps for the other classes record: uv origin 2210ms, gh-proxy 280ms, ghfast 340ms;
pypi origin timeout (eliminated), tuna 260ms, aliyun 275ms, tencent 290ms; npmjs 1750ms,
npmmirror 240ms; npmmirror PBS 250ms, GitHub PBS 2100ms.

**Step 2 — pick per class:**

- `nodeDist`: origin alive (1840ms), so a mirror must be decisively faster to win
  (≤ 0.6 × 1840 = 1104ms); npmmirror qualifies at 430ms, tuna at 295ms is strictly faster
  than npmmirror beyond the ±10% tie band → **tuna** wins. Tuna is the stale slot, so
  Step 4's version resolution must verify the resolved version exists there before
  downloading.
- `uvRelease`: origin alive (2210ms); gh-proxy 280 ≤ 1326 → **gh-proxy** wins.
- `pypiIndex`: origin dead → fastest alive → **tuna** (260ms).
- `npmRegistry`: origin alive (1750ms); npmmirror 240 ≤ 1050 → **npmmirror**.
- `pbsMirror`: mirror-preferred class, npmmirror alive → **npmmirror**.

**Step 3 — persist** to `/home/me/proj/.zcode/.runtime/runtime.json` with all measurement
lines, `ttlDays: 7`, and today's `probedAt`.

**Step 4 — resolve exact versions:** `https://nodejs.org/dist/index.json` (small, tolerable
over slow link) gives newest `v22.14.0` — and the tuna check passes because tuna's
`v22.14.0/SHASUMS256.txt` probes 206 (the version exists there). GitHub API latest gives
`0.8.6`. Both pinned into `runtime.json`.

**Step 5 — download + cross-source verify:**

```bash
curl -fL -o <rt>/node-v22.14.0-linux-x64.tar.xz \
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz"
curl -fsS -o <rt>/SHASUMS256.txt \
  "https://registry.npmmirror.com/-/binary/node/v22.14.0/SHASUMS256.txt"   # OTHER source, not tuna
cd <rt> && sha256sum -c --ignore-missing SHASUMS256.txt    # node-v22.14.0-linux-x64.tar.xz: OK

curl -fL -o <rt>/uv-x86_64-unknown-linux-gnu.tar.gz \
  "https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/0.8.6/uv-x86_64-unknown-linux-gnu.tar.gz"
# digest from api.github.com (DIRECT), matched by asset name:
echo "6d1c…  uv-x86_64-unknown-linux-gnu.tar.gz" | (cd <rt> && sha256sum -c -)
```

Note the checksum sources: node's SHASUMS comes from npmmirror although the tarball came from
tuna (the checksum always comes from the nodejs.org ↔ npmmirror pair — the source that did not
serve the tarball; tuna never verifies anything); uv's digest comes from `api.github.com`
directly although the tarball rode gh-proxy (proxies are transport only). `sha256sum -c` says
OK for both — had either mismatched, the artifact would be deleted and the run stopped there.

**Steps 6–8 — unpack, CURRENT, env, AGENTS.md:** node lands at
`<rt>/node/v22.14.0/bin/{node,npm,npx}`, uv at `<rt>/uv/0.8.6/{uv,uvx}`; `CURRENT` files are
written write-then-rename. The AGENTS.md marker block exports
`PATH=<rt>/node/v22.14.0/bin:<rt>/uv/0.8.6:$PATH` plus `UV_*` and `npm_config_registry` in its
bash/PowerShell/cmd sections.

**Step 9 — wire the entry:**

```json
"context7": {
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp"],
  "pathPrepend": ["/home/me/proj/.zcode/.runtime/node/v22.14.0/bin"],
  "env": { "npm_config_registry": "https://registry.npmmirror.com" }
}
```

**Step 10 — verify:**

```text
$ <rt>/node/v22.14.0/bin/node --version
v22.14.0
$ <rt>/node/v22.14.0/bin/npm config get registry
https://registry.npmmirror.com
$ <rt>/uv/0.8.6/uvx --version
uv 0.8.6
```

The registry line proves the mirror env took effect. Report: versions, per-class sources with
latencies, checksum results, files touched; remind the user the server connects on the *next*
task and suggest refreshing the MCP settings list.

---

## 2. Update — node minor bump

`runtime.json` is 9 days old (TTL 7) and the user asks to update node. Re-probe (fresh
measurements), resolve `v22.15.0` from `index.json`. The new version installs into a **new**
directory — `v22.14.0/` is untouched while servers still run from it:

```bash
tar -xJf <rt>/node-v22.15.0-linux-x64.tar.xz -C <rt>/node
mv <rt>/node/node-v22.15.0-linux-x64 <rt>/node/.unpack-$$ && mv <rt>/node/.unpack-$$ <rt>/node/v22.15.0
printf '%s' "v22.15.0" > <rt>/node/CURRENT.tmp-$$ && mv -f <rt>/node/CURRENT.tmp-$$ <rt>/node/CURRENT
```

Then rewrite every reference to the old versioned bin dir: `pathPrepend` in the wired MCP
entries → `…/node/v22.15.0/bin`, the AGENTS.md marker block (replace between markers), and
`runtime.json`'s `versions.node`. Finally best-effort GC:

```bash
rm -rf <rt>/node/v22.14.0     # if a running server still holds it open: POSIX keeps the process
                              # alive on the old inode and the unlink just works; on Windows a
                              # file lock makes this fail — keep the dir, disclose, move on
```

`node --version` under the new dir confirms `v22.15.0`; running tasks keep their old runtime
until they end (no restart required).

---

## 3. Remove — teardown

The user wants the workspace runtime gone and the server back on the system runtime.

1. Delete all runtime state: `rm -rf <rt>` (the whole `.zcode/.runtime` tree, `runtime.json`
   and `CURRENT` files included).
2. Strip the AGENTS.md block, markers included (one `sed` range-delete, `patterns.md` §11).
3. In `.agents/mcp.json`, remove the keys this skill added from the affected entries —
   `pathPrepend`, and the mirror env keys (`npm_config_registry`, `UV_DEFAULT_INDEX`,
   `UV_PYTHON_INSTALL_MIRROR`, the `UV_*` dir pins) — leaving `command`/`args` and anything
   else as they were.
4. Next task, verify the fallback: `npx` resolves from the system PATH (or the app-level
   runtime if one exists) and the server either connects or fails with a clear error — report
   which. If the machine has no system node at all, say so and suggest re-running this skill
   or installing a runtime another way.
