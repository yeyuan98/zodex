# Workspace runtime command patterns

Copy-pasteable command shapes for the steps in `SKILL.md`. Fragments, not a script — substitute
`<ws>`, `<rt>`, `<node-ver>`, `<uv-ver>` and the platform triple before running. Commands are
given for bash (unix) and, where they differ, PowerShell/cmd (Windows).

---

## 1. Probe one candidate

One small Range GET, timed. Accept 206 or 200; any curl failure (including the 5s timeout)
eliminates the candidate.

```bash
probe() { # probe <label> <url>
  out=$(curl -sS -o /dev/null -w '%{http_code} %{time_total}' \
        -r 0-65536 --max-time 5 "$2" 2>/dev/null) || out="000 0"
  code=${out%% *}; secs=${out##* }
  ms=$(awk -v s="$secs" 'BEGIN { printf "%.0f", s * 1000 }')
  ok=false; [ "$code" = 200 ] || [ "$code" = 206 ] && ok=true
  printf '{candidate: %s, httpCode: %s, latencyMs: %s, ok: %s}\n' "$1" "$code" "$ms" "$ok"
}
```

Every line this prints goes into the session output verbatim — the measurements are the audit
trail and the fallback order.

PowerShell equivalent (Windows legs use this shape):

```powershell
function probe($label, $url) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.AddRange(0, 65536); $req.Timeout = 5000; $req.Method = "GET"
    $resp = $req.GetResponse(); $code = [int]$resp.StatusCode; $resp.Close()
  } catch { $code = 0 }
  $sw.Stop()
  $ok = ($code -eq 200 -or $code -eq 206)
  "{candidate: $label, httpCode: $code, latencyMs: $([int]$sw.ElapsedMilliseconds), ok: $ok}"
}
```

## 2. Probe sweep for one class (nodeDist, first run)

```bash
node_ver=$(jq -r '.versions.node // empty' <rt>/runtime.json 2>/dev/null) || node_ver=""
[ -n "$node_ver" ] || node_ver=v22.14.0   # built-in known-good probe tag (v22 line)

probe nodejs.org/dist                     "https://nodejs.org/dist/$node_ver/SHASUMS256.txt"
probe registry.npmmirror.com/-/binary/node "https://registry.npmmirror.com/-/binary/node/$node_ver/SHASUMS256.txt"
probe tuna/nodejs-release                 "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/dist/$node_ver/SHASUMS256.txt"
```

The probe version is the *last pinned* version from `runtime.json`; only a first run (no file)
falls back to the built-in known-good tags `v22.14.0` (node) / `0.8.6` (uv). The other classes
follow the same shape with their probe URLs from `SKILL.md` Step 1:

```bash
uv_ver=0.8.6   # or: jq -r '.versions.uv' <rt>/runtime.json
probe github/uv-origin "https://github.com/astral-sh/uv/releases/download/$uv_ver/sha256.sum"
probe gh-proxy         "https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/$uv_ver/sha256.sum"
probe ghfast           "https://ghfast.top/https://github.com/astral-sh/uv/releases/download/$uv_ver/sha256.sum"

probe pypi-origin "https://pypi.org/simple/"
probe pypi-tuna   "https://pypi.tuna.tsinghua.edu.cn/simple/"
probe pypi-aliyun "https://mirrors.aliyun.com/pypi/simple/"
probe pypi-tencent "https://mirrors.cloud.tencent.com/pypi/simple/"

probe npm-origin   "https://registry.npmjs.org/react"
probe npm-npmmirror "https://registry.npmmirror.com/react"

probe pbs-npmmirror "https://registry.npmmirror.com/-/binary/python-build-standalone"
probe pbs-github    "https://github.com/astral-sh/python-build-standalone/releases/download"
```

## 3. runtime.json

See `SKILL.md` Step 3 for the full shape. Read/interpret for **status**:

```bash
jq '{probedAt, ttlDays, versions, decisions}' <rt>/runtime.json
cat <rt>/node/CURRENT <rt>/uv/CURRENT 2>/dev/null; echo
test -x <rt>/node/$(cat <rt>/node/CURRENT)/bin/node && echo "node bin present"
```

If a `CURRENT` read comes back empty, unparseable, or pointing at a missing directory: treat
that runtime as absent and warn — never scan for the highest `v<ver>` directory.

## 4. Resolve exact versions (after probing)

```bash
# node: origin index.json, npmmirror same-named file as fallback. Entries are newest-first.
curl -fsS --max-time 20 https://nodejs.org/dist/index.json -o /tmp/node-index.json \
  || curl -fsS --max-time 20 https://registry.npmmirror.com/-/binary/node/index.json -o /tmp/node-index.json
node_ver=$(jq -r '[.[] | select(.version | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].version' /tmp/node-index.json)

# uv: GitHub API latest — always DIRECT, never via gh-proxy/ghfast.
uv_ver=$(curl -fsS --max-time 20 https://api.github.com/repos/astral-sh/uv/releases/latest | jq -r .tag_name)
```

Pin both into `runtime.json` (`versions.node`, `versions.uv`) before building any download URL.
Never take a version from an npmmirror `latest-*` directory — those are stale.

## 5. uv checksum via GitHub API (direct)

```bash
curl -fsS --max-time 20 "https://api.github.com/repos/astral-sh/uv/releases/tags/$uv_ver" -o /tmp/uv-release.json
jq -r '.assets[] | select(.name == "uv-x86_64-unknown-linux-gnu.tar.gz") | .digest' /tmp/uv-release.json
# -> "sha256:<hex>" — strip the "sha256:" prefix for sha256sum -c
```

## 6. Platform filename table

| Platform | node archive | uv archive |
| --- | --- | --- |
| linux x64 | `node-<node-ver>-linux-x64.tar.xz` | `uv-x86_64-unknown-linux-gnu.tar.gz` |
| linux arm64 | `node-<node-ver>-linux-arm64.tar.xz` | `uv-aarch64-unknown-linux-gnu.tar.gz` |
| macOS x64 | `node-<node-ver>-darwin-x64.tar.xz` | `uv-x86_64-apple-darwin.tar.gz` |
| macOS arm64 | `node-<node-ver>-darwin-arm64.tar.xz` | `uv-aarch64-apple-darwin.tar.gz` |
| windows x64 | `node-<node-ver>-win-x64.zip` | `uv-x86_64-pc-windows-msvc.zip` |

Download URLs: node `<nodeDist-winner>/<node-ver>/<archive>`; uv
`<uvRelease-winner>/<uv-ver>/<archive>` (for the proxy candidates the winner URL *is*
`https://gh-proxy.com/<origin-url>`).

## 7. Download + cross-source verify

node — tarball from one source, `SHASUMS256.txt` from the other of nodejs.org ↔ npmmirror:

```bash
curl -fL --retry 2 -o <rt>/node-<node-ver>-linux-x64.tar.xz \
  "https://registry.npmmirror.com/-/binary/node/<node-ver>/node-<node-ver>-linux-x64.tar.xz"
curl -fsS -o <rt>/SHASUMS256.txt "https://nodejs.org/dist/<node-ver>/SHASUMS256.txt"  # the OTHER source

cd <rt> && sha256sum -c --ignore-missing SHASUMS256.txt   # must say OK; mismatch -> delete + report + STOP
```

uv — checksum is ALWAYS the GitHub API asset digest (pattern §5, api.github.com direct;
api.github.com unreachable → STOP, never an alternative checksum source):

```bash
curl -fL --retry 2 -o <rt>/uv-x86_64-unknown-linux-gnu.tar.gz \
  "https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/<uv-ver>/uv-x86_64-unknown-linux-gnu.tar.gz"
echo "<hex-from-api-digest>  uv-x86_64-unknown-linux-gnu.tar.gz" | (cd <rt> && sha256sum -c -)
```

Windows checksum: `certutil -hashfile <file> SHA256` and compare by eye (or `sha256sum -c` if
you have one). gh-proxy/ghfast are transport for the tarball only — never a checksum source,
never piped into a shell.

## 8. Unpack + normalize + CURRENT

unix:

```bash
mkdir -p <rt>/node <rt>/uv
tar -xJf <rt>/node-<node-ver>-linux-x64.tar.xz -C <rt>/node     # unpacks node-<node-ver>-linux-x64/
mv <rt>/node/node-<node-ver>-linux-x64 <rt>/node/.unpack-$$ && mv <rt>/node/.unpack-$$ <rt>/node/<node-ver>

tar -xzf <rt>/uv-x86_64-unknown-linux-gnu.tar.gz -C <rt>/uv      # unpacks uv-x86_64-unknown-linux-gnu/
mv <rt>/uv/uv-x86_64-unknown-linux-gnu <rt>/uv/.unpack-$$ && mv <rt>/uv/.unpack-$$ <rt>/uv/<uv-ver>

printf '%s' "<node-ver>" > <rt>/node/CURRENT.tmp-$$ && mv -f <rt>/node/CURRENT.tmp-$$ <rt>/node/CURRENT
printf '%s' "<uv-ver>"  > <rt>/uv/CURRENT.tmp-$$  && mv -f <rt>/uv/CURRENT.tmp-$$  <rt>/uv/CURRENT
```

node keeps `bin/`; uv's top-level `uv-<triple>/` is stripped so `uv` and `uvx` sit together.

Windows (built-in tar.exe handles both .zip and .tar.xz; layouts end flat):

```powershell
New-Item -ItemType Directory -Force <rt>\node, <rt>\uv
tar -xf <rt>\node-<node-ver>-win-x64.zip -C <rt>\node
Move-Item <rt>\node\node-<node-ver>-win-x64 <rt>\node\<node-ver>
# uv zip 也是先解到临时目录再改名——半解包目录绝不落在最终 v<ver> 名下（与 Step 6.1 一致）
New-Item -ItemType Directory -Force <rt>\uv\.unpack-$PID
tar -xf <rt>\uv-x86_64-pc-windows-msvc.zip -C <rt>\uv\.unpack-$PID   # zip is flat
Move-Item <rt>\uv\.unpack-$PID <rt>\uv\<uv-ver>

Set-Content -NoNewline -Path <rt>\node\CURRENT.tmp-$PID -Value "<node-ver>"
Move-Item -Force <rt>\node\CURRENT.tmp-$PID <rt>\node\CURRENT
Set-Content -NoNewline -Path <rt>\uv\CURRENT.tmp-$PID -Value "<uv-ver>"
Move-Item -Force <rt>\uv\CURRENT.tmp-$PID <rt>\uv\CURRENT
```

Everything downstream references the versioned bin dir
(`<rt>/node/<node-ver>/bin`, `<rt>/uv/<uv-ver>` on unix; `<rt>/node/<node-ver>`,
`<rt>/uv/<uv-ver>` on Windows) — never the `CURRENT` pointer.

## 9. AGENTS.md marker block

Idempotent: when `<!-- zcode-runtime:start -->` already exists, replace everything through its
matching `<!-- zcode-runtime:end -->`; otherwise append once. Full template in `SKILL.md`
Step 8. Size guard:

```bash
size=$(wc -c < <ws>/AGENTS.md); [ "$size" -lt 92000 ] || echo "WARN: AGENTS.md at ${size}/102400 bytes — suggest pruning before appending"
```

## 10. MCP entry wiring

New npx entry (`.agents/mcp.json`, `mcpServers` key) — `pathPrepend` carries the absolute
versioned bin dir, `env` carries the mirror keys:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "pathPrepend": ["/abs/ws/.zcode/.runtime/node/v22.14.0/bin"],
      "env": { "npm_config_registry": "https://registry.npmmirror.com" }
    },
    "sqlchat": {
      "command": "uvx",
      "args": ["mcp-server-sqlchat"],
      "pathPrepend": ["/abs/ws/.zcode/.runtime/uv/0.8.6"],
      "env": {
        "UV_DEFAULT_INDEX": "https://pypi.tuna.tsinghua.edu.cn/simple",
        "UV_PYTHON_INSTALL_MIRROR": "https://registry.npmmirror.com/-/binary/python-build-standalone"
      }
    }
  }
}
```

Backfill: any existing entry with `command` `npx`/`uvx`/`npx.cmd`/`uvx.cmd` gets the matching
`pathPrepend`; do not touch anything else in the entry. On Windows, JSON paths use escaped
backslashes (`C:\\ws\\...`) or forward slashes. Changes take effect on the next task.

## 11. Verify / teardown one-liners

```bash
<rt>/node/<node-ver>/bin/node --version
<rt>/node/<node-ver>/bin/npm config get registry     # must print the chosen mirror
<rt>/uv/<uv-ver>/uvx --version
```

Teardown (remove): delete `<rt>`; delete the AGENTS.md block between the markers (markers
included); strip `pathPrepend` + the mirror env keys this skill added from MCP entries:

```bash
rm -rf <rt>
sed -i.bak '/<!-- zcode-runtime:start -->/,/<!-- zcode-runtime:end -->/d' <ws>/AGENTS.md && rm <ws>/AGENTS.md.bak
```
