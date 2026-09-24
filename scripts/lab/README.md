# Darjeeling test lab

`scripts/lab/lab.sh` runs the heavy checks for this repo on the lab host
(a Debian box with rootless podman), from your Mac. The Mac only rsyncs the
working tree and prints results. Everything runs in disposable `dj-lab-*`
containers that are removed when the run ends.

```
scripts/lab/lab.sh ci                         # build + tests + lint, about 1 min when warm
scripts/lab/lab.sh install debian13           # cold-install test of install-darjeeling.sh
scripts/lab/lab.sh install all -j 2           # all four distros, two at a time
scripts/lab/lab.sh status                     # slots, containers, images, disk
scripts/lab/lab.sh e2e-spike --fetch /tmp/e2e  # real Obsidian under Xvfb, one chat turn desktop + mobile
scripts/lab/lab.sh clean [--all]              # remove lab containers, volumes, run dirs
```

It tests the working tree as it is on disk, uncommitted changes included. It
never tests git HEAD.

## Requirements

- On the Mac: `ssh` access to the lab host in BatchMode (key auth), `rsync`
  (the macOS openrsync is fine), and bash 3.2 or later.
- A lab host: copy `lab.env.example` to `lab.env`, which is git-ignored, and
  set `DJ_LAB_HOST=user@host`, or export `DJ_LAB_HOST`. The tool has no
  built-in default, so a public checkout never points at anyone's machine.
- On the host: rootless podman 5+, `flock`, and outbound internet from containers.
  The host needs no other setup. Images are built on first use and cached.

Settings (environment variables, all optional):

| Variable | Default | Meaning |
|---|---|---|
| `DJ_LAB_HOST` | (none; from `lab.env`) | ssh target |
| `DJ_LAB_REMOTE_DIR` | `dj-lab` | lab root, relative to the remote `$HOME` |
| `DJ_LAB_SLOTS` | `2` | lab jobs that may run on the host at once; extra callers queue |
| `DJ_LAB_MAX_CONTAINERS` | `2` | maximum running `dj-lab-*` containers, counting ones started outside this tool |
| `DJ_LAB_MEMORY` / `DJ_LAB_CPUS` | `2g` / `2` | per-container limits |
| `DJ_LAB_SLOT_WAIT` | `3600` | seconds to queue before giving up |
| `DJ_LAB_KEEP_RUNS` | `8` | run directories kept per kind |
| `DJ_LAB_KEEP=1` | off | keep the container (install) or `node_modules` (ci) for debugging |
| `DJ_LAB_REBUILD=1` | off | rebuild the cached image even if its recipe is unchanged |

## Sharing the host

The host is the owner's live personal server, and it runs the real
`darjeeling.service`. The lab is built so that several people can use it
without overloading it:

- **Slots.** Each run takes one of `DJ_LAB_SLOTS` flock locks
  (`~/dj-lab/.slot.N.lock`) before doing any work. When all slots are busy,
  new runs queue. A lock belongs to the process holding it, so a killed run
  frees its slot at once.
- **Container budget.** Before it starts a container, a run waits until fewer
  than `DJ_LAB_MAX_CONTAINERS` `dj-lab-*` containers are running. This
  counts containers from other tools as well.
- **Cleanup.** Every container is labelled `dj-lab.tool=lab`,
  `dj-lab.run=<id>` and `dj-lab.started=<epoch>`. Runs remove their own
  containers on exit. Ctrl-C on the Mac removes the run's containers
  remotely. Runs also reap any lab container older than 3 hours.
- **Limits.** Nothing touches `darjeeling.service`, `~/darjeeling-server`,
  `~/vault`, `~/.claude*`, `~/.config` or `~/.ssh` on the host. Nothing runs
  as root on the host, and nothing changes host networking. Containers use
  podman's default user-mode networking, so they have internet access but
  cannot see the Meshnet interface.
- **No secrets leave the Mac.** rsync excludes `server/config.env`,
  `server/.token`, `.env*`, `*.pem`, `*.key`, `.credentials.json` and
  `server/deepseek_sessions/`. The tests use fake agents and fake API keys
  only.

## `lab.sh ci`

This command syncs the tree to `~/dj-lab/ci/<run>/` and runs
`lib/ci-stages.sh` in a container built from `images/Containerfile.ci`
(node:22-bookworm plus Python 3.11, tmux and shellcheck). npm and pip caches
live in the named volumes `dj-lab-npm-cache` and `dj-lab-pip-cache`.

| Stage | What | Fails the run when |
|---|---|---|
| `plugin:deps` | `npm ci` when there is a lockfile, otherwise `npm install` (WARN) | install fails |
| `plugin:tsc` | `tsc -noEmit -skipLibCheck` | any type error |
| `plugin:build` | `npm run build` (CSS, tsc, esbuild production) | build fails |
| `plugin:generated-drift` | committed `main.js`/`styles.css` compared with a fresh build | never (WARN) |
| `plugin:mobile-safe-requires` | no module-scope `require("fs"/"child_process"/…)` in `main.js` | one is found (it would crash plugin load on iOS/Android) |
| `plugin:test` | `npm test` | a test fails |
| `plugin:manifest` | `lib/check-manifest.cjs`: version sync across manifest, package, versions and server, plus community-directory rules and release hygiene | a hard rule is broken |
| `server:deps` | a venv with `server/requirements.txt`, pytest and pyflakes | pip fails |
| `server:py_compile` / `server:import` | every `.py` compiles, and `server.py` imports | error |
| `server:pyflakes` | undefined names, unused imports | never (WARN) |
| `server:requirements-drift` | the installer's inlined requirements compared with `server/requirements.txt` | never (WARN) |
| `server:pytest` | `tests/server/` (see below) | a test fails, or a strict xfail unexpectedly passes |
| `shellcheck` | every `*.sh`, plus extensionless files with a bash/sh shebang | any finding at `warning` level or above |

Options: `--stages plugin,server,shell` runs a subset. Set
`DJ_LAB_PYTEST_ARGS="--runxfail --tb=short"` to see the real failures behind
the known-bug xfails. Logs are written to
`~/dj-lab/ci/<run>/_lab/logs/<stage>.log` on the host.

## `lab.sh install <distro>`

Supported distros: `debian12`, `debian13`, `ubuntu2204`, `ubuntu2404`, `ubuntu2604`, or
`all`. For each one the command:

1. Builds (and caches) `localhost/dj-lab/<distro>` from
   `~/dj-lab/images/Containerfile.debian`, falling back to
   `images/Containerfile.systemd`, with the right `BASE`. The image is a
   "fresh server": systemd as PID 1, sudo, curl, and a NOPASSWD user
   `tester`. It deliberately has no git, python or node.
2. Starts a systemd container and copies the tree to `/home/tester/darjeeling`.
3. Runs `lib/install-check.sh` inside it. That script refuses to run outside
   a container. It runs the repo's `install-darjeeling.sh` as `tester` via
   `sudo`, with stdin set to `/dev/null`, then checks:
   - `darjeeling.service` is active and enabled, runs as `tester` and not
     as root, and survives a restart (`--extended`)
   - `/health` answers on the bound address, and nothing listens on 0.0.0.0
   - the REST auth matrix: no token or a wrong token gives 401; Bearer and
     `X-Darjeeling-Token` give 200; REST `?token=` is refused
   - the WebSocket handshake with the subprotocol token (echo plus ping/pong),
     how bad tokens are rejected, and a tmux PTY round trip over
     `/ws/terminal`
   - `config.env` and `.token` are mode 0600 and owned by the user, and the
     token has at least 32 characters
   - the toolchain: Node 22 or later, and `claude` resolvable on the unit's
     PATH
   - a real structured turn through the fake `claude` and `agy`, on a second
     server instance started from the installed venv
   - what a new user sees from the real, not-yet-logged-in Claude Code
     (recorded to `real-claude-unauth.ndjson`)
   - whether the token reaches journald
   - idempotency: re-running keeps the token and `config.env`, keeps the
     unit stable, keeps the user's `~/.tmux.conf` edits, and the service
     comes back healthy
4. Copies the results out to `~/dj-lab/install/<run>/_lab/<distro>/` and
   destroys the container. Use `--keep` to leave it running for debugging.

Result statuses in `results.tsv`: `PASS`, `FAIL` (the contract is broken and
the run exits 1), `BUG` (a confirmed defect outside the core contract),
`WARN`, and `INFO`.

Options:

- `-j 2`: run two distros at once. The maximum is 2.
- `--extended`: also tests the documented update advice
  (`sudo npm install -g @anthropic-ai/claude-code@latest`) and a service restart.
- `--patch node,meshnet,owner` (or `all`): if the unmodified installer fails,
  the command retries with a patched copy that exists only inside the
  container, so the checks behind the fatal bugs still run. The unpatched
  failure is still reported. `node` adds `|| true` to
  install-darjeeling.sh:86, `meshnet` to :163, and `owner` chowns
  `~/darjeeling-server` right after it is created (:142).
- `--skip-rerun`: skips the idempotency pass.

### Networking during install tests

The current installer always runs NordVPN's remote install script
(install-darjeeling.sh:67-81) and has no opt-out. The lab never lets that
script run. `install-check.sh` puts a logging no-op `nordvpn` shim on PATH, so
`command -v nordvpn` succeeds and the step is skipped. The installer also
masks sleep targets and edits `logind.conf` unconditionally. Inside a
container that affects only the container.

The harness already passes the environment that a rewritten installer should
honour. The current script ignores it:

| Variable | Intended meaning |
|---|---|
| `DARJEELING_NETWORK=none` | do not install or configure any VPN (`nordvpn` / `tailscale` / `none`) |
| `DARJEELING_BIND=127.0.0.1` | explicit bind address; skip auto-detection |
| `DARJEELING_POWER=skip` | do not touch logind or mask sleep targets |
| `DARJEELING_ASSUME_YES=1` | never prompt; fail with a message instead |
| `DEBIAN_FRONTEND=noninteractive` | passed through to apt |

## `lab.sh clean`

`clean` removes `dj-lab-*` containers, the `dj-lab-*` volumes (the npm and pip
caches) and the run directories. With `--all` it also removes the lab images
and the base images they were pulled from. It refuses to run while a lab run
holds a slot, or while a running `dj-lab-*` container exists that lab.sh did
not start (someone else's). `--force` overrides both checks, and `--dry-run`
prints the plan without doing anything. It never touches
`~/dj-lab/images/` or `~/dj-lab/<name>/` directories.

## `lab.sh e2e-spike`

This is a feasibility spike for the plugin E2E suite, and the seed of that
suite. It builds `e2e/Containerfile.obsidian` (Obsidian's `.deb`, Xvfb,
playwright-core) and sets up the following inside the container:

- a local `server.py` with the fake agents
- a test vault with the committed `plugin/main.js`, `manifest.json`,
  `styles.css`, and a `data.json` pointing at the server
- a registered `obsidian.json`

It then launches Obsidian with `--remote-debugging-port=9222 --no-sandbox`.
`e2e/spike.mjs` attaches over CDP, enables community plugins, sends a chat
turn through the real composer, waits for the fake reply, and takes a
screenshot. It repeats the turn after `app.emulateMobile(true)` at a
390x844 viewport. `--fetch DIR` copies the screenshots and logs back to the
Mac.

## Test fixtures (`tests/`)

- `tests/fakes/fake_agent.py`, with the wrappers `tests/fakes/bin/claude` and
  `tests/fakes/bin/agy`: a stdlib-only stand-in for Claude Code and Antigravity.
  It parses the argv the server builds, including the commander-style
  variadic flags the real CLI uses, and replays a scenario as NDJSON.
  Scenarios are picked by `FAKE_AGENT_SCENARIO`, by `#scenario:<name>` in
  the prompt, or by default (`basic` / `agy-basic`). The scenario files live
  in `tests/fakes/scenarios/*.ndjson`: `basic`, `partial`, `slow`,
  `big-line`, `error-result`, `not-logged-in`, `raw-stdout`, `crash`,
  `agy-basic`. The directives are `sleep`, `stderr`, `raw`,
  `big_tool_result`, `wait_for_signal` and `exit`. `FAKE_AGENT_ARGV_LOG`
  records every invocation. `FAKE_AGENT_TRANSCRIPTS=1` writes
  `~/.claude/projects/<slug>/<sid>.jsonl` the way the real CLI does. Only use
  it with a temporary `HOME`.
- `tests/server/`: pytest against a real `server.py` process on 127.0.0.1.
  HOME, vault, `TMUX_TMPDIR` and PATH all point into a throwaway `/tmp/djlab*`
  directory, and a fake DeepSeek SSE endpoint stands in for the API. It is
  Linux-only (the server's turn accounting reads `/proc`). Known bugs are
  `xfail(strict=True)` with the defect's file:line in the reason. When a bug
  is fixed, the suite goes red until the marker is removed.

## Adding a check

- CI stage: add a block to `lib/ci-stages.sh` using `run <name> cmd...`, then
  `record STATUS name "$SECS" "detail"`.
- Install assertion: add it to `lib/install-check.sh` with
  `res STATUS name detail`. For network checks, add a function to
  `lib/probe.py`, which runs under the installed server's venv.
- Keep every script shellcheck-clean at all levels. `lab.sh ci` enforces
  warning level and above.
