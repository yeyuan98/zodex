---
name: zcode-config-reference
description: "Configuration file contracts for MCP servers, skills, and plugins in ZCode workspaces: which files are read (.zcode/config.json mcp.servers, .agents/mcp.json mcpServers, at workspace and user level), every stdio/http server field including the pathPrepend PATH-injection list and env whole-key replacement semantics, next-task-effective timing, SKILL.md frontmatter rules for the skills directories, and the boundary between workspace-level vendoring and the desktop plugin store."
when_to_use: "Use when asked to configure or add MCP servers or skills, when editing .zcode or .agents config files, or when deciding where an MCP/skill/plugin capability should be installed."
---

# ZCode configuration reference

Where configuration files live, what their fields mean, and when changes take effect. Use this
skill before writing to any `.zcode` or `.agents` config file — the `.agents` conventions are
guessable, the `.zcode` paths are not.

## MCP server configuration

Four files are read and merged **per server name** (same-name conflicts resolve per entry,
not per file): a server defined in any of them is available in every workspace (user level)
or this workspace only (workspace level):

| Level | `.zcode` leg | `.agents` leg |
| --- | --- | --- |
| workspace | `<ws>/.zcode/config.json` → key `mcp.servers` | `<ws>/.agents/mcp.json` → key `mcpServers` |
| user | `~/.zcode/cli/config.json` → key `mcp.servers` | `~/.agents/mcp.json` → key `mcpServers` |

Both legs are equivalent in effect; keep a workspace's servers in `<ws>/.agents/mcp.json`
(the widely-followed convention) unless the user already uses the `.zcode` leg.

**Same-name conflict rule (per entry, not per file):** when both legs in the same scope
define the same server name, the `.zcode` leg wins for that name — only that one
`.agents` entry is shadowed, and `.agents`-unique names still load. Across scopes, a
user-level entry with the same name shadows the workspace-level entry. This is the classic
incident pattern: writing an entry into `<ws>/.agents/mcp.json` while a user-level file
(`~/.zcode/cli/config.json` or `~/.agents/mcp.json`) already defines that name makes the
workspace edit silently lose — check both user-level files when a workspace entry refuses
to take effect.

### stdio server fields

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"stdio"` | Optional: an entry with a `command` and no `type` is stdio by default. |
| `command` | string | Executable to spawn, e.g. `npx`, `uvx`, or an absolute path. Resolved left-to-right along the final PATH. |
| `args` | string[] | Arguments passed to the command. |
| `env` | object | Extra environment for the spawned process. **Whole-key replacement**: each key here replaces that key entirely — an explicit `env.PATH` replaces the *whole* PATH (killing the runtime prepend and the inherited login PATH). Prefer `pathPrepend` over writing `env.PATH`. |
| `pathPrepend` | string[] | Directories prepended to the far left of PATH when spawning this server. Elements support `~`/`~/` expansion and **must be absolute after expansion** — a relative element makes the server config invalid (rejected loudly, never silently dropped or truncated). Prepended at spawn time after `env` is applied, so it wins even over an explicit `env.PATH`: highest PATH precedence. Elements join with the platform path separator. |
| `timeoutMs` | number | Positive startup timeout in milliseconds. |
| `isolation` | `"session" \| "workspace"` | Server instance sharing scope — **protocol shape only** (desktop → CLI session payload). No file leg carries it: the strict server schema for both `.zcode/config.json` and `.agents/mcp.json` rejects this key, and writing it in either file drops the whole server entry with a warning. |
| `protocolVersion` | `"auto" \| "legacy" \| "2026-07-28"` | MCP protocol negotiation mode. |
| `enabled` | boolean | Defaults to true; `false` keeps the entry but does not start it. |
| `cwd` | string | Working directory for the spawned process (both file legs). Scope-dependent resolution: project-scope entries resolve a relative path against the config file's directory (the workspace root containing `.zcode`/`.agents`); user-level entries keep it unnormalized and the spawn resolves it against the session working directory. |

http-shaped servers use `type: "http"` (or `"sse"`), `url`, and `headers` (a legacy
`http_headers` key on the `.zcode` leg is migrated to `headers`).

**Strict schema warning (both file legs):** the CLI validates each server entry in
`<ws>/.zcode/config.json` and `<ws>/.agents/mcp.json` with the same strict schema — an
unknown field makes it drop the *whole server* with a warning diagnostic
(`config_mcp_server_invalid`), not just the field. Do not invent fields on either leg;
write only the fields above that apply to your server's shape.

Example entry (see the `zcode-workspace-runtimes` skill when `command` is `npx`/`uvx` and the
machine has no runtime):

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "pathPrepend": ["/abs/path/to/workspace/.zcode/.runtime/node/v22.14.0/bin"],
      "env": { "npm_config_registry": "https://registry.npmmirror.com" },
      "timeoutMs": 60000
    }
  }
}
```

### When changes take effect

MCP server configuration is **next-task-effective**: a running task keeps the servers it
already assembled; edits apply when the next task (or a new session) starts.

**Known residual:** editing these files directly does *not* trigger the desktop's
draft-session invalidation — that seam fires on desktop-side write actions (settings page,
sync service), not on file changes made underneath it. Recommend starting a new task after
config edits so the change is picked up deliberately, rather than relying on a running draft
to notice.

## Skills

Skill directories are discovered at four roots; a skill is a directory containing a
`SKILL.md`:

| Level | `.zcode` root | `.agents` root |
| --- | --- | --- |
| workspace | `<ws>/.zcode/skills/<name>/SKILL.md` | `<ws>/.agents/skills/<name>/SKILL.md` |
| user | `~/.zcode/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |

`SKILL.md` starts with an optional YAML frontmatter block (`---` fences). The contract:

- `name` — required; non-empty; should match the directory name.
- `description` — required whenever frontmatter is present; one line; **at most 1024
  characters** (longer descriptions are rejected at load time).
- `when_to_use` — optional; one line steering when the agent should pick the skill.
- `license` and `metadata` are also recognized keys.
- A `SKILL.md` is capped at 100 KB.

New skills appear in the **next session's** skill list. Same-name skills resolve by root
order; user/project roots override the bundled pack that ships with the CLI.

## Plugins — the vendoring boundary

Plugins can carry MCP definitions and skills. Two different things must be distinguished:

- **The capabilities a plugin brings** (its MCP server definitions, its skills) *can* be
  vendored: copy the MCP entry into `<ws>/.agents/mcp.json` and the skill directory into
  `<ws>/.agents/skills/`, and the effect is equivalent to what the plugin would provide.
  When the user wants a capability, this workspace-level vendoring is the supported route.
- **The plugin body itself** (executable code, assets, update lifecycle) is installed only
  through the zodex global: `~/.zcode/cli/plugins` plus the `installed_plugins.json`
  registry, sourced from the marketplace. Manually editing that directory or registry is
  **unsafe and unsupported** — do not do it, and say so when asked.

The guidance in one line: want an MCP server or a skill → vendor it into workspace-level
config; want the full plugin experience (updates, marketplace identity) → use the desktop
plugin store.

## Cross-reference

When an MCP server's `command` is `npx`/`uvx` and the machine lacks Node.js/uv (a
`runtime_unavailable` failure), read the `zcode-workspace-runtimes` skill: it provisions
workspace-level runtimes and generates the `pathPrepend`/mirror-`env` wiring shown above.
