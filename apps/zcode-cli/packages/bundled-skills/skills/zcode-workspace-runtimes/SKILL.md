---
name: zcode-workspace-runtimes
description: "Provision workspace-level Node.js and uv runtimes so npx/uvx-based MCP servers start on machines with no system runtime or a slow network: probe download mirrors independently per artifact class (node dist, uv releases, PyPI index, npm registry, python-build-standalone), pick sources deterministically, pin exact versions, download tarballs and verify them against checksums from a different source, unpack into versioned directories under .zcode/.runtime with an atomic CURRENT pointer, pin UV_*/npm registry mirror env, annotate AGENTS.md, and wire pathPrepend into MCP config entries."
when_to_use: "Use when an MCP server fails with runtime_unavailable, when npx or uvx is missing on the machine, or when runtime downloads need China-mainland mirrors because nodejs.org, GitHub, PyPI or registry.npmjs.org are slow or unreachable. Also use it to show status, update, or remove an existing workspace runtime."
---

# Workspace runtimes (Node.js + uv)

This skill makes a workspace self-sufficient for `npx`- and `uvx`-based MCP servers: it installs
complete Node.js and uv distributions into the workspace, picks the fastest usable download
source, verifies every tarball against a checksum from a *different* source, and wires the
resulting binaries into MCP config entries and `AGENTS.md`. Nothing outside the workspace is
modified — no system packages, no global shims, no shell rc files.

Follow the steps in order. Each step has a defensive check; when a check fails, do the failure
action it names (usually STOP and report) instead of improvising.

## Symbols

| Symbol | Meaning |
| --- | --- |
| `<ws>` | Workspace root (absolute) |
| `<rt>` | `<ws>/.zcode/.runtime` — all runtime state lives here |
| `<node-ver>` | Exact Node.js version, always with the `v` prefix, e.g. `v22.14.0` |
| `<uv-ver>` | Exact uv version, no `v` prefix (uv tags have none), e.g. `0.8.6` |

Versioned install layout and the bin directories other config must reference (absolute,
deterministic — never depend on the `CURRENT` pointer):

| Runtime | Directory | Contents | Bin dir for PATH |
| --- | --- | --- | --- |
| node (unix) | `<rt>/node/<node-ver>/` | complete dist, `bin/` kept as distributed | `<rt>/node/<node-ver>/bin` |
| node (win) | `<rt>/node/<node-ver>/` | flat: `node.exe`, `npm.cmd`, `npx.cmd` at top level | `<rt>/node/<node-ver>` |
| uv (unix) | `<rt>/uv/<uv-ver>/` | `uv` and `uvx` side by side (`uv-<triple>/` top level stripped) | `<rt>/uv/<uv-ver>` |
| uv (win) | `<rt>/uv/<uv-ver>/` | flat: `uv.exe`, `uvx.exe` | `<rt>/uv/<uv-ver>` |

## Non-negotiable rules

These hold at every step; violating any of them is a bug in your execution, not a shortcut:

1. **Cross-source checksums.** A tarball downloaded from source X is verified against a checksum
   obtained from a *different* source (Step 5). Never verify a download against itself.
2. **Proxies are transport only.** `gh-proxy.com` and `ghfast.top` may carry bytes; their content
   is never a checksum source and is never piped into a shell.
3. **Exact versions only.** Pin an exact `vX.Y.Z` (node) / `X.Y.Z` (uv) into `runtime.json`
   *before* constructing any download URL. The `latest-*` directories on npmmirror are stale —
   never use them.
4. **Versioned dirs + atomic CURRENT.** Installs go to a new `v<ver>/` directory; the sibling
   `CURRENT` file is replaced by write-then-rename, so a reader always sees the old or the new
   value, never a half-written one.
5. **Zero system modification.** Everything lands under `<rt>`; MCP entries get `pathPrepend`;
   `AGENTS.md` gets a marker block. Nothing else.
6. **STOP on verification failure.** Checksum mismatch, all-dead probes, or an unreachable
   checksum anchor each end in STOP + report (see "Hard stops"), never in a silent downgrade to
   an unverified install.

---

## Step 1 — Probe mirror candidates

Probe each artifact class **independently** — the fastest PyPI mirror says nothing about the
fastest node dist source. Candidate tables are fixed; do not invent mirrors.

| Class (`nodeDist`) | Candidates, in order |
| --- | --- |
| 1 | `https://nodejs.org/dist` (origin) |
| 2 | `https://registry.npmmirror.com/-/binary/node` |
| 3 | `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/dist` — STALE mirror, probe slot only; see below |

| Class (`uvRelease`) | Candidates, in order |
| --- | --- |
| 1 | `https://github.com/astral-sh/uv/releases/download` (origin) |
| 2 | `https://gh-proxy.com/<origin-url>` — proxy over candidate 1's URL |
| 3 | `https://ghfast.top/<origin-url>` — proxy over candidate 1's URL |

| Class (`pypiIndex`) | Candidates, in order |
| --- | --- |
| 1 | `https://pypi.org/simple` (origin) |
| 2 | `https://pypi.tuna.tsinghua.edu.cn/simple` |
| 3 | `https://mirrors.aliyun.com/pypi/simple` |
| 4 | `https://mirrors.cloud.tencent.com/pypi/simple` |

| Class (`npmRegistry`) | Candidates, in order |
| --- | --- |
| 1 | `https://registry.npmjs.org` (origin) |
| 2 | `https://registry.npmmirror.com` |

| Class (`pbsMirror`) | Candidates, in order |
| --- | --- |
| 1 | `https://registry.npmmirror.com/-/binary/python-build-standalone` (preferred — this is where `UV_PYTHON_INSTALL_MIRROR` points) |
| 2 | `https://github.com/astral-sh/python-build-standalone/releases/download` (origin) |

Probe one candidate with a single small Range GET — `curl -r 0-65536 --max-time 5`, accepting
HTTP 206 or 200. Record one line per candidate in the session output, shaped
`{candidate, httpCode, latencyMs, ok}` (the exact command lives in `patterns.md` §1–2).

**Probe URL per class** (small file, first 64 KB):

- `nodeDist`: `<base>/<node-ver>/SHASUMS256.txt`
- `uvRelease`: `<base>/<uv-ver>/sha256.sum`
- `pypiIndex`: `<base>/simple/` → for the origins/mirrors above the URL is just `<base>/`
- `npmRegistry`: `<base>/react` or `<base>/-/ping`
- `pbsMirror`: `<base>` directory JSON

**Which version goes into the probe URL:** the version pinned in the previous round of
`runtime.json`. On the first run (no `runtime.json` yet) use this skill's built-in known-good
probe tags — **node `v22.14.0`** (v22 LTS line) and **uv `0.8.6`** (0.8 line) — which exist on
every candidate above and are defaults for probing only, not install recommendations.

A probe measures transport latency only; it does not prove the artifact you will eventually
download exists. Failure or timeout (including curl exit ≠ 0) eliminates the candidate.

**Tuna stale-slot rule:** tuna may win on latency, but it is stale. If tuna wins `nodeDist`,
verify the exact version exists there (Range-GET its `SHASUMS256.txt` for the version you
resolved in Step 4); if the version is missing, treat tuna as failed and continue with the
next-best candidate from the measurements.

## Step 2 — Pick one source per class (deterministic)

Apply these rules to each class independently, in order:

1. **Origin alive** → a mirror/proxy wins only if `latency(mirror) ≤ 0.6 × latency(origin)`;
   otherwise the origin wins. (When both are fast, keep the official source.)
2. **Origin dead or timed out** → the fastest alive candidate wins.
3. **Tie (within ±10%)** → the candidate earlier in the table wins.
4. **All candidates dead** → STOP. Report the measurements and offer the manual override
   (`--base <url>` parameter, or a hand-edited `manual` field in `runtime.json` — see
   "Manual override"). Never silently pick an unusable source.

`pbsMirror` is the one class where the mirror is preferred by design: npmmirror is candidate 1
and GitHub is the fallback used only when npmmirror is dead. (uv reads this mirror directly via
`UV_PYTHON_INSTALL_MIRROR`, so it must stay the npmmirror binary path whenever alive.)

## Step 3 — Persist decisions and measurements

Write the results to `<rt>/runtime.json` (create `<rt>/` first):

```json
{
  "probedAt": "2026-10-07T12:00:00.000Z",
  "ttlDays": 7,
  "decisions": {
    "nodeDist":    { "baseUrl": "https://registry.npmmirror.com/-/binary/node" },
    "uvRelease":   { "baseUrl": "https://github.com/astral-sh/uv/releases/download" },
    "pypiIndex":   { "baseUrl": "https://pypi.tuna.tsinghua.edu.cn/simple" },
    "npmRegistry": { "baseUrl": "https://registry.npmmirror.com" },
    "pbsMirror":   { "baseUrl": "https://registry.npmmirror.com/-/binary/python-build-standalone" }
  },
  "measurements": [
    { "candidate": "nodejs.org/dist", "httpCode": 206, "latencyMs": 1840, "ok": true },
    { "candidate": "registry.npmmirror.com/-/binary/node", "httpCode": 206, "latencyMs": 310, "ok": true }
  ],
  "versions": { "node": "v22.14.0", "uv": "0.8.6" }
}
```

Keep every measurement line (all candidates, including dead ones) — the fallback order in
Step 5's retry is derived from them.

**Re-probe triggers:** `probedAt` older than `ttlDays` (7 days); an explicit refresh request;
or a hard download failure of the chosen source (then first retry the next-best source from
`measurements`; only when every measured source has failed do you run a full re-probe).

## Step 4 — Resolve and pin exact versions (after probing)

1. **node:** GET `https://nodejs.org/dist/index.json` (origin, small JSON). On failure, use
   npmmirror's same-named file `https://registry.npmmirror.com/-/binary/node/index.json`.
   Entries are ordered newest-first; take the first entry whose `version` matches
   `^v\d+\.\d+\.\d+$` — that exact `<node-ver>`.
   **Never** resolve a node version from an `latest-*` directory name: on npmmirror those are
   stale.
2. **uv:** GET `https://api.github.com/repos/astral-sh/uv/releases/latest` — always DIRECT,
   no proxy. Read `tag_name` → `<uv-ver>`.
3. Pin both into `runtime.json` (`versions.node`, `versions.uv`) **before** constructing any
   download URL. If you cannot resolve a version (both index sources dead, or GitHub API
   unreachable), STOP and report — do not guess a version from memory.

## Step 5 — Download and verify (cross-source)

For each runtime (skip one if the user only asked for the other):

1. **Download the tarball** from the class winner chosen in Step 2, into `<rt>/` (exact
   filenames per platform in `patterns.md` §6).
2. **Fetch the checksum from a different source** — the invariant is *tarball from X, checksum
   from the OTHER source*:
   - **node:** `SHASUMS256.txt` from the *other* one of `nodejs.org/dist/<node-ver>/` ↔
     `registry.npmmirror.com/-/binary/node/<node-ver>/`. (Tarball from a mirror → checksum from
     the origin, and vice versa. Tuna never serves as a checksum source.)
    - **uv:** the GitHub API release object's asset `digest` field
      (`api.github.com/repos/astral-sh/uv/releases/tags/<uv-ver>`, small JSON, always DIRECT —
      never via gh-proxy/ghfast, and never the `sha256.sum` file from a proxied or origin release
      URL). If `api.github.com` is unreachable, STOP with an explicit error advising
      a retry later; **never downgrade to an unverified install**.
3. **Verify before unpack:** `sha256sum -c` (or `certutil -hashfile <file> SHA256` on Windows)
   against the downloaded tarball. **On mismatch: delete the tarball, report both sources, and
   STOP.** Do not unpack, and do not retry the same pair silently.
4. A download that 404s or hard-fails on the chosen source is a re-probe trigger (Step 3):
   retry the next-best source from `measurements` first; re-probe only when all measured
   sources have failed.

## Step 6 — Unpack into the versioned layout and write CURRENT

1. Unpack into a temporary sibling first (e.g. `<rt>/node/.unpack-<node-ver>-<pid>/`), then
   rename it to `<rt>/node/<node-ver>/` — a half-unpacked directory must never be the target.
   On Windows use the built-in `tar.exe` for both `.zip` and `.tar.xz`.
2. Normalize the layout: node unix keeps `bin/`; node win strips the `node-v<ver>-win-x64/`
   top level (flat); uv unix strips the `uv-<triple>/` top level so `uv` and `uvx` sit
   side by side; uv win is flat as shipped.
3. Write the pointer file — a plain-text sibling whose content is exactly the version-dir name:

   ```bash
   printf 'v22.14.0' > <rt>/node/CURRENT.tmp-$$ && mv -f <rt>/node/CURRENT.tmp-$$ <rt>/node/CURRENT
   ```

   The write-`CURRENT.tmp*`-then-rename sequence is the atomicity contract; never write
   `CURRENT` in place. Clean up leftover `CURRENT.tmp*` files afterwards.
4. **Windows file locks:** an old version directory may be locked by still-running servers, so
   GC of old dirs is best-effort — if removal fails, keep the directory, say so, and move on.
   (POSIX keeps running processes alive on the old inode; Windows retains the directory until
   the process exits.)

`pathPrepend` entries and the AGENTS.md block reference the **versioned bin dir** from the
table above — absolute and deterministic, never the `CURRENT` pointer.

## Step 7 — Pin the environment

These keys are written wherever this skill wires env (MCP entries in Step 9, the AGENTS.md
block in Step 8). Lowercase `npm_config_registry` is deliberate: npm's env is
case-insensitive but lowercase wins inside run-scripts.

| Key | Value |
| --- | --- |
| `UV_CACHE_DIR` | `<rt>/uv/cache` |
| `UV_PYTHON_INSTALL_DIR` | `<rt>/uv/python` |
| `UV_TOOL_DIR` | `<rt>/uv/tools` |
| `UV_TOOL_BIN_DIR` | `<rt>/uv/bin` |
| `UV_PYTHON_INSTALL_MIRROR` | `https://registry.npmmirror.com/-/binary/python-build-standalone` (the `pbsMirror` winner's URL) |
| `UV_DEFAULT_INDEX` | chosen `pypiIndex` base URL |
| `npm_config_registry` | chosen `npmRegistry` base URL |

## Step 8 — Append the AGENTS.md marker block

Append (or replace, if the markers already exist — the block is idempotent, never duplicated)
to `<ws>/AGENTS.md`:

```markdown
<!-- zcode-runtime:start -->
<!-- Managed by the zcode-workspace-runtimes skill. Rerun the skill to update; do not hand-edit. -->

Runtime provisioned in this workspace: node <node-ver>, uv <uv-ver>.

bash / zsh (Linux, macOS, Git Bash):

    export PATH="<rt>/node/<node-ver>/bin:<rt>/uv/<uv-ver>:$PATH"
    export UV_CACHE_DIR="<rt>/uv/cache"
    export UV_PYTHON_INSTALL_DIR="<rt>/uv/python"
    export UV_TOOL_DIR="<rt>/uv/tools"
    export UV_TOOL_BIN_DIR="<rt>/uv/bin"
    export UV_PYTHON_INSTALL_MIRROR="https://registry.npmmirror.com/-/binary/python-build-standalone"
    export UV_DEFAULT_INDEX="<chosen pypi>"
    export npm_config_registry="<chosen registry>"

PowerShell (Windows):

    $env:PATH = "<rt>\node\<node-ver>;<rt>\uv\<uv-ver>;$env:PATH"
    $env:UV_CACHE_DIR = "<rt>\uv\cache"
    ... (same keys, Windows paths)

cmd (Windows):

    set PATH=<rt>\node\<node-ver>;<rt>\uv\<uv-ver>;%PATH%
    set UV_CACHE_DIR=<rt>\uv\cache
    ... (same keys, Windows paths)
<!-- zcode-runtime:end -->
```

All three per-OS sections are required (future sessions may run under any of them). Use
absolute paths. Before writing, check the 100 KB AGENTS.md cap: if the file is at or near
102400 bytes, warn and suggest pruning — never truncate silently.

## Step 9 — Wire MCP entries

MCP config lives in `<ws>/.agents/mcp.json` (`mcpServers` key) and/or
`<ws>/.zcode/config.json` (`mcp.servers`); field semantics are documented in the
`zcode-config-reference` skill.

- **New or edited entries** for `npx`/`uvx` servers carry `pathPrepend` (absolute versioned
  bin dirs from the Step 6 table) plus the mirror env keys from Step 7:

  ```json
  "context7": {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp"],
    "pathPrepend": ["<ws>/.zcode/.runtime/node/<node-ver>/bin"],
    "env": { "npm_config_registry": "https://registry.npmmirror.com" }
  }
  ```

  Prefer `pathPrepend` over writing `env.PATH` — `env.PATH` replaces the whole PATH and kills
  both the runtime prepend and the inherited login PATH.
- **Existing entries** with `command: "npx"` / `"uvx"` (and Windows `.cmd` variants) get
  `pathPrepend` backfilled the same way; leave the rest of the entry untouched.
- uv servers additionally get the `UV_*` keys from Step 7 in their `env`.

Changes are **next-task-effective**: running tasks keep their already-assembled servers; the
wiring pays off on the next task/session start.

## Step 10 — Verify

Run, with the Step 7 env exported into your shell (or via the wired MCP entry):

```bash
<rt>/node/<node-ver>/bin/node --version      # prints <node-ver>
<rt>/node/<node-ver>/bin/npm config get registry   # prints the chosen registry, not npmjs default
<rt>/uv/<uv-ver>/uvx --version               # prints uv <uv-ver>
```

`npm config get registry` is the check that the mirror env actually took effect — if it prints
`https://registry.npmjs.org/` while you selected a mirror, the env did not reach npm; fix the
wiring before reporting success. Then suggest the user refresh the MCP settings list
(re-probe) and confirm the previously failing server connects on the next task. Report:
versions installed, source chosen per class with its measured latency, checksum verification
result, and the files touched.

---

## Lifecycle

| Operation | What you do |
| --- | --- |
| **install** | Steps 1–10. |
| **status** | Read `<rt>/runtime.json` (versions, decisions, `probedAt` vs TTL) and the `CURRENT` files; check the versioned bin dirs exist. Interpret: report pinned versions, chosen sources with latency, probe age, and whether a re-probe is due. **Read-side tolerance for `CURRENT`:** missing, unparseable, or pointing at a directory that no longer exists = treat the runtime as absent and warn — **never** fall back to scanning for the highest `v<ver>` directory (that would resurrect a version pending GC). |
| **test** | Step 10's three commands; then have the MCP settings list refreshed to re-probe server statuses. |
| **update** | Re-run install (re-probe if TTL expired) → the new version lands in a **new** `v<ver>/` directory → atomically rewrite `CURRENT` → rewrite `pathPrepend` in MCP entries, the AGENTS.md block, and `runtime.json` to the new versioned paths → best-effort GC of the old version dir (Windows file locks: keep + disclose; ws-level GC has no retry hook — leftover dirs are cleaned by a later update/remove). |
| **remove** | Delete `<rt>/` entirely; strip the AGENTS.md marker block (both markers and everything between them); remove the `pathPrepend` and mirror env keys this skill added from MCP entries (leave anything else in the entry alone); then verify on the next task that `npx`/`uvx` servers fall back to the system PATH (or the app-level runtime) and connect or fail loudly — report the outcome. |

## Hard stops

Each of these ends the operation with an explicit report — no silent degradation:

- **Checksum mismatch** (Step 5.3): delete the artifact, report both sources, STOP.
- **All candidates dead for a class** (Step 2.4): report measurements, offer the manual
  override, STOP.
- **Checksum anchor unreachable** (`api.github.com` for uv, Step 5.2): explicit error advising
  retry later — installing without a checksum is never an option.
- **Version resolution failed** (Step 4.3): report, STOP; do not guess versions from memory.
- **AGENTS.md at the 100 KB cap** (Step 8): warn and suggest pruning; do not truncate.

## Manual override

When probes are all dead (or the user asks), accept a `--base <url>` override per artifact
class, or a hand-edited `runtime.json` decision carrying `"manual": true` plus `"baseUrl"`.
A manual base is used verbatim, without probing — but every other invariant still applies:
exact version resolution, cross-source checksums, atomic layout. Record manual decisions in
`measurements` as `{candidate: "manual:<class>", httpCode: 0, latencyMs: 0, ok: true}` so the
next status read can tell them apart.

---

Command-level details (probe snippets, platform filename tables, checksum commands, CURRENT
writes for both unix and Windows) are in `${ZCODE_SKILL_DIR}/patterns.md`; a full worked
install, an update, and a teardown are in `${ZCODE_SKILL_DIR}/examples.md`. Configuration-file
contracts (where MCP entries live, what `pathPrepend` means to the runtime) are documented in
the `zcode-config-reference` skill.
