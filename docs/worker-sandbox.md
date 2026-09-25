# The worker sandbox: design note

Status: **approved design (2026-09-25), with the rulings in §7.** This is the boundary that every threat-model
note in `accuracy-e.md` (§11.8) defers to. Today the goal loop's records are tamper-evident
against the API but not unforgeable: the worker's shell runs as the same OS user as the server
and the desktop app.

## 1. What has to hold

The worker is the model's shell, whatever `bash` (or a background task, or a check) runs. It must
not be able to:

| Deny | What | Why |
|---|---|---|
| write | `opencode.json`, `opencode.jsonc`, `.opencode/` in the worktree | project config and plugins decide models, tools, rules |
| write | the global config dir (`$XDG_CONFIG_HOME/opencode`, `%APPDATA%\opencode`), the managed config dir | the same, for every project; `goal_verifier.checks` lives here |
| write | OpenCode's data dir (`$XDG_DATA_HOME/opencode`: the SQLite database, snapshots, archives) | the records themselves |
| write | the Electron `userData` dir | goal-loop state, the last input, check approvals |
| read | `userData/server.json`, the server password in any environment variable | the API credential |
| process | open, signal, debug or read the memory of the server, the Electron processes | the host token is in their memory; killing the server is a denial of the loop |
| network | the server's port (unless it is authenticated and the credential is unreadable) | the API |

It must still be able to: read and write the worktree (except the paths above), run the
toolchain (node, bun, git, cargo, python, ...), use package-manager caches, reach package
registries when the policy allows, and bind localhost ports for its own tests.

## 2. One policy, three backends

The policy is the harness's existing `SandboxPolicy` (`legatus-harness`,
`harness-domain/src/sandbox.rs`): `mode` (`None`, `ReadOnly`, `WorkspaceWrite`),
`writable_roots` and `network` (`Allow`, `Deny`, or an `Allowlist` of hosts). This design adds:

- `deny_read` and `deny_write` path lists (the table above): they always win over
  `writable_roots`;
- `env_scrub`: variables removed from the child's environment (`OPENCODE_SERVER_PASSWORD`, the
  server URL, `*_TOKEN` variables named by config);
- `caches`: per-tool cache dirs that are writable, redirected per project where the tool allows
  it (`npm_config_cache`, `BUN_INSTALL_CACHE_DIR`, `PIP_CACHE_DIR`, `CARGO_TARGET_DIR`).

The server builds the policy per session: `WorkspaceWrite` with the worktree root for a worker;
`ReadOnly` for the verifier's session (its checks run `WorkspaceWrite`, since the build writes).

### Windows (first)

- **AppContainer.** Each worktree gets an AppContainer profile
  (`CreateAppContainerProfile`). The shell starts with its SID in `SECURITY_CAPABILITIES`
  (`STARTUPINFOEX`).
  - An AppContainer process reaches no user file unless an ACE grants its SID. The config
    dirs, the data dir, `userData` and `server.json` are therefore denied by default.
  - The launcher grants the worktree read/write and the toolchain directories read/execute.
    Program Files already allows ALL APPLICATION PACKAGES. User-installed toolchains under
    `%LOCALAPPDATA%` (bun, nvm, scoop, rustup) need explicit grants.
  - It also grants a deny ACE on `opencode.json` and `.opencode\` inside the worktree.
- **Process access.** AppContainer tokens cannot open medium-integrity processes. The server
  and Electron cannot be opened, signaled or debugged.
- **Job object** around every shell:
  - kill on job close, so killing the tool kills the tree;
  - no breakaway;
  - UI restrictions (no clipboard, global atoms or desktop switching);
  - a process count and a memory cap.
- **Network.**
  - An AppContainer without the `internetClient` capability has no network.
  - With it, it has the internet but not loopback. Loopback needs a per-profile exemption, which
    opens every local port.
  - So `Allowlist` goes through an egress proxy, and localhost for the worker's own tests needs
    the loopback exemption (open question 1).
- **Fallback when AppContainer is unavailable** (old Windows, some AV products): a restricted
  token (deny-only SIDs, low integrity) plus a job object. Low integrity blocks writes up but
  not reads, so `server.json` must then be protected by its ACL alone. Weaker; say so in the UI.

### Linux

- **bubblewrap**, where unprivileged user namespaces are allowed:
  - mounts: `--ro-bind` of `/usr`, `/etc` (a subset) and the toolchains; `--bind` of the
    worktree; read-only overlays over `opencode.json` and `.opencode/`; `$HOME` hidden except
    the cache dirs;
  - `--unshare-pid`, so the server and Electron are not even visible;
  - `--unshare-net`, plus the egress proxy's socket bound in;
  - `--die-with-parent` and `--new-session`;
  - a seccomp filter: no `ptrace`, `process_vm_*`, `keyctl`, `bpf` or `mount`.
- **Landlock plus seccomp**, where user namespaces are off (Ubuntu 24.04 restricts them through
  AppArmor):
  - Landlock is allow-only: the launcher lists the readable and writable roots, and the denied
    paths are simply not in them;
  - ABI 4 adds TCP connect/bind rules by port, and ABI 6 scopes signals and abstract unix
    sockets, which keeps the shell from signaling the server;
  - on older kernels, rely on `ptrace_scope=1` (the server is not a descendant) and say the
    signal scope is missing.

### macOS

- **Seatbelt** (`sandbox-exec` with a generated profile; deprecated, but still what Codex and
  Claude Code use):
  - `(deny default)`;
  - `(allow file-read*)` except the denied paths;
  - `(allow file-write*)` for the worktree and caches, with explicit denies for `opencode.json`
    and `.opencode`;
  - `(deny process-info* (target others))` and `(deny signal (target others))`;
  - `(deny network*)`, allowing only the proxy's unix socket and local ports when the policy
    allows them;
  - `(deny mach-lookup)` except a short list (notifyd, the DNS resolver's service).
- `server.json` sits under `~/Library/Application Support/<app>` and is denied by path.

## 3. How tools are launched inside it

- **One shared crate**, `legatus-sandbox`, implements `SandboxPolicy` per OS behind
  `run(policy, argv, env, cwd) -> Child`.
  - The Rust harness links it: its local shell today refuses every mode but `None`, which is
    this seam.
  - OpenCode (Bun) uses its binary, `legatus-sandbox run --policy <file> -- <argv>`, from
    `tool/shell.ts` (`cmd()`) and `tool/shell/tasks.ts` (the background tasks). Both already
    spawn through one `ChildProcess.make`.
  - The binary is the only place with OS-specific code, and it is small enough to sign.
    Norton flags new binaries on this machine (known), which is another reason to keep it small
    and signed.
- The policy file is written by the server into its own data dir (which the sandbox denies) and
  passed by path, so the worker cannot rewrite the policy of its next command.
- What is not wrapped:
  - in-process tools (edit, write, read) are gated by permission rules and the verifier lock, as
    today;
  - MCP servers, LSPs and formatters start from trusted config and run as the server, out of
    scope here (open question 4);
  - the verifier's checks are wrapped like any shell.

## 4. What breaks, and how to allow it

| What | Breaks because | Allow by |
|---|---|---|
| npm/bun/pnpm/pip/cargo install | network, global caches | caches redirected per project; registries on the proxy allowlist |
| git commit, branch | nothing (`.git` is in the worktree) | none needed |
| git push, fetch over SSH or HTTPS | ssh-agent socket, credential helpers, network | not from the worker by default; the host pushes. Opt-in: a credential-helper proxy |
| git commit signing | gpg-agent / keychain access | off in the sandbox (`commit.gpgsign=false` in its env), or an opt-in socket |
| dev servers and tests on localhost | loopback (Windows), network namespace (Linux) | bind is allowed inside the namespace (Linux, macOS); on Windows, the loopback exemption (open question 1) |
| docker | the daemon socket is root-equivalent | denied; out of scope |
| browsers (Playwright) | GPU, display, shared memory | a profile preset; not in the default policy |
| toolchains under the user profile | not readable by the AppContainer | grants computed from `PATH` at session start, reviewed in the UI |

## 5. Rollout

1. The crate with the Windows backend, the policy type and its tests. Red-first tests are
   integration tests that try each deny, one per row of §1.
2. OpenCode wraps shell spawns behind a setting (`sandbox.mode`), default `None`. The goal loop
   refuses `completed` without the sandbox once it is on (a verification in an unsandboxed
   session is flagged in the checkpoint).
3. Linux (bubblewrap, then Landlock), then macOS.
4. The harness's local shell accepts `WorkspaceWrite` and `ReadOnly` through the crate.

## 6. Open questions

1. **Windows loopback:** give the worker loopback (its tests need localhost, but the server port
   is then reachable, guarded only by auth plus an unreadable credential), or run the worker's
   dev servers inside the job with a port broker?
2. **Egress:** a host-run allowlist proxy (HTTP CONNECT, domain-based), or the OS firewall per
   AppContainer SID / network namespace, with no domain awareness? The proxy is uniform across
   OSes.
3. **AppContainer ACL grants on the user's own files** (the worktree, toolchains) change their
   ACLs. Add them and remove them per session, or keep one persistent profile per worktree? On
   Windows, can the grants be inherited-only, so the user's own tools are unaffected?
4. MCP servers and plugins run with the server's rights: sandbox them too (a separate policy),
   or keep them trusted as configured?
5. **Detection:** how does the loop know the sandbox is really on? For example, a canary: the
   launcher tries a denied write at start and fails closed if it succeeds.
6. **DPAPI in an AppContainer:** confirm that the user's `safeStorage` key (check approvals) is
   unreachable from the container.

## 7. Rulings (2026-09-25)

1. **Loopback is allowed** for the worker: its localhost tests need it. The server stays
   protected by its auth, by the password and host token being unreadable inside the
   container, and by the Host/Origin guard. A port broker is a later option.
2. **Egress** goes through a host-run proxy with a default-deny domain allowlist: package
   registries and git hosts, from trusted config. The OS firewall is a backstop only.
3. **One persistent AppContainer profile per worktree.** Its grants are made once, and removed
   when the worktree is removed; they are not made per session.
4. **MCP servers and plugins** are sandboxed too, as a phase-2 item. Today they come from trusted
   config only.
5. **A startup self-test is required** in every sandboxed session. It tries:
   - a denied write;
   - a denied read of the token;
   - opening the server process.

   Any success means the session is not sandboxed: it fails closed, and the goal loop cannot
   report `completed`.
6. **The AppContainer must not be able to unseal the approvals key.** This is a required
   self-test case.

**Implementation:** a new crate `harness-sandbox` in `legatus-harness`, with its small, signed
launcher binary. Windows first, behind a setting that is off by default, in PR-sized units,
each red-first. The harness's shell spawn reaches it only through a new port method.
