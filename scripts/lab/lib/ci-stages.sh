#!/usr/bin/env bash
# Runs INSIDE the disposable CI container. /work is a synced copy of the repo.
# Prints one line per stage and writes _lab/summary.tsv + _lab/logs/<stage>.log.
# Exit 1 if any stage FAILs. WARN never fails the run.
set -uo pipefail

W=/work
OUT="$W/_lab"
LOGS="$OUT/logs"
rm -rf "$LOGS"
mkdir -p "$LOGS"
: >"$OUT/summary.tsv"
STAGES="${DJ_LAB_STAGES:-all}"
FAILS=0
WARNS=0
VENV=/tmp/dj-venv
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore

want() { [ "$STAGES" = all ] || [[ ",$STAGES," == *",$1,"* ]]; }

record() { # STATUS NAME SECONDS DETAIL
    printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$OUT/summary.tsv"
    printf '%-5s %-30s %4ss  %s\n' "$1" "$2" "$3" "$4"
    case "$1" in
        FAIL) FAILS=$((FAILS + 1)) ;;
        WARN) WARNS=$((WARNS + 1)) ;;
    esac
}

# run NAME CMD... : run CMD with output to logs/NAME.log; sets SECS and RC.
run() {
    local name=$1
    shift
    local t0=$SECONDS
    "$@" >"$LOGS/$name.log" 2>&1
    RC=$?
    SECS=$((SECONDS - t0))
    return 0
}

# Every *.sh plus extensionless files with a bash/sh shebang (tests/fakes/bin/*).
list_shell_files() {
    local f
    find . -path ./node_modules -prune -o -path ./_lab -prune -o -type f -print |
        while IFS= read -r f; do
            case "$f" in
                (*.sh) printf '%s\n' "$f" ;;
                (*) if head -n 1 "$f" 2>/dev/null | grep -qE '^#!.*\b(bash|sh)\b'; then printf '%s\n' "$f"; fi ;;
            esac
        done
}

tail_hint() { # last meaningful line of a log, for the summary
    grep -v '^\s*$' "$LOGS/$1.log" 2>/dev/null | tail -n 1 | cut -c1-110
}

{
    echo "node $(node --version) / npm $(npm --version)"
    python3 --version
    shellcheck --version | sed -n 2p
    tmux -V
} >"$LOGS/env.log" 2>&1

# ------------------------------------------------------------------ plugin
if want plugin; then
    cd "$W" || exit 1

    # The community directory installs with `npm ci --ignore-scripts` and builds
    # with no Python on the box (AC-11); deps and build run the same way here.
    # PATH holds node's directory plus a directory with only `sh` (npm runs
    # scripts through it; /bin is /usr/bin on bookworm and has python3).
    mkdir -p /tmp/dj-sh-only && ln -sf /bin/sh /tmp/dj-sh-only/sh
    NODE_ONLY_PATH="$(dirname "$(command -v node)"):/tmp/dj-sh-only"
    if env PATH="$NODE_ONLY_PATH" sh -c 'command -v python3 || command -v python' >/dev/null; then
        record FAIL plugin:no-python 0 "python is reachable on the node-only PATH ($NODE_ONLY_PATH)"
    fi
    if [ -f package-lock.json ]; then
        run plugin-deps env PATH="$NODE_ONLY_PATH" npm ci --ignore-scripts
        if [ "$RC" -eq 0 ]; then
            record PASS plugin:deps "$SECS" "npm $(npm --version) ci --ignore-scripts, PATH=$NODE_ONLY_PATH"
        else
            record FAIL plugin:deps "$SECS" "$(tail_hint plugin-deps)"
        fi
    else
        record FAIL plugin:deps 0 "no package-lock.json; npm ci is impossible"
    fi

    run plugin-tsc npx --no-install tsc -noEmit -skipLibCheck
    n_ts=$(grep -c 'error TS' "$LOGS/plugin-tsc.log" || true)
    if [ "$RC" -eq 0 ]; then
        record PASS plugin:tsc "$SECS" "0 type errors"
    else
        record FAIL plugin:tsc "$SECS" "$n_ts type errors (logs/plugin-tsc.log)"
    fi

    run plugin-build env PATH="$NODE_ONLY_PATH" npm run build
    if [ "$RC" -eq 0 ]; then
        record PASS plugin:build "$SECS" "css + tsc + esbuild production, no python on PATH"
    else
        record FAIL plugin:build "$SECS" "$(tail_hint plugin-build)"
    fi

    # isDesktopOnly=false: a module-scope require of a Node builtin kills plugin
    # load on iOS/Android. Lazy requires inside functions are fine.
    run plugin-mobile-requires grep -nE \
        '^(var|let|const) [A-Za-z0-9_$]+ = (__toESM\()?require\("(node:)?(child_process|fs|os|path|net|tls|http|https|crypto|electron|stream|util|worker_threads|readline|zlib|dns|pty|node-pty)"\)' \
        main.js
    if [ ! -f main.js ]; then
        record FAIL plugin:mobile-safe-requires 0 "main.js missing"
    elif [ "$RC" -eq 0 ]; then
        record FAIL plugin:mobile-safe-requires 0 "module-scope Node builtin require in main.js (see log)"
    else
        record PASS plugin:mobile-safe-requires 0 "no module-scope Node builtin requires; main.js $(wc -c <main.js) bytes"
    fi

    run plugin-test npm test
    if [ "$RC" -eq 0 ]; then
        record PASS plugin:test "$SECS" "$(grep -E '^(# |ℹ )pass ' "$LOGS/plugin-test.log" | awk '{print $NF}' | tail -n 1) tests passed (node --test)"
    else
        record FAIL plugin:test "$SECS" "$(tail_hint plugin-test)"
    fi

    run plugin-manifest node "$W/scripts/lab/lib/check-manifest.cjs" "$W"
    if [ "$RC" -eq 0 ]; then
        if grep -q '^WARN' "$LOGS/plugin-manifest.log"; then
            record WARN plugin:manifest 0 "$(grep -c '^WARN' "$LOGS/plugin-manifest.log") warnings (logs/plugin-manifest.log)"
        else
            record PASS plugin:manifest 0 "versions consistent"
        fi
    else
        record FAIL plugin:manifest 0 "$(grep -c '^FAIL' "$LOGS/plugin-manifest.log") errors, $(grep -c '^WARN' "$LOGS/plugin-manifest.log") warnings (logs/plugin-manifest.log)"
    fi

    run plugin-egress bash "$W/scripts/ci/egress-audit.sh" --report
    if [ "$RC" -eq 0 ]; then
        record PASS plugin:egress-audit "$SECS" "all network call sites accounted for"
    else
        record FAIL plugin:egress-audit "$SECS" "$(tail_hint plugin-egress)"
    fi
fi

# ------------------------------------------------------------------ server
if want server; then
    cd "$W" || exit 1
    if [ -f server/requirements.lock ]; then
        run server-venv bash -c "python3 -m venv $VENV && $VENV/bin/pip install -q --require-hashes -r server/requirements.lock && $VENV/bin/pip install -q pytest pyflakes"
    else
        run server-venv bash -c "python3 -m venv $VENV && $VENV/bin/pip install -q -r server/requirements.txt pytest pyflakes"
    fi
    if [ "$RC" -eq 0 ]; then
        record PASS server:deps "$SECS" "$($VENV/bin/python --version) + server/requirements.lock"
    else
        record FAIL server:deps "$SECS" "$(tail_hint server-venv)"
    fi
    PY="$VENV/bin/python"
    [ -x "$PY" ] || PY=python3

    mapfile -t pyfiles < <(find server tests scripts -name '*.py' -not -path '*/node_modules/*' 2>/dev/null)
    run server-py-compile "$PY" -m py_compile "${pyfiles[@]}"
    if [ "$RC" -eq 0 ]; then
        record PASS server:py_compile "$SECS" "${#pyfiles[@]} files"
    else
        record FAIL server:py_compile "$SECS" "$(tail_hint server-py-compile)"
    fi

    run server-import env -i PATH=/usr/bin:/bin HOME=/tmp DARJEELING_TOKEN=ci \
        DARJEELING_TOKEN_FILE=/tmp/ci.token PYTHONPATH="$W/server" "$PY" -c \
        "import darjeeling_server as m; print('VERSION', m.VERSION, 'routes', len(m.app.routes))"
    if [ "$RC" -eq 0 ]; then
        record PASS server:import "$SECS" "$(tail_hint server-import)"
    else
        record FAIL server:import "$SECS" "$(tail_hint server-import)"
    fi

    run server-pyflakes "$VENV/bin/pyflakes" server
    n_flakes=$(grep -c . "$LOGS/server-pyflakes.log" || true)
    if [ "$n_flakes" -eq 0 ]; then
        record PASS server:pyflakes "$SECS" "clean"
    else
        record WARN server:pyflakes "$SECS" "$n_flakes findings (logs/server-pyflakes.log)"
    fi

    # Installer uses hash-locked requirements.lock
    if [ -f server/requirements.lock ] && grep -q -- '--hash=' server/requirements.lock; then
        record PASS server:requirements-drift 0 "installer uses hash-locked requirements.lock"
    elif [ -f install-darjeeling.sh ]; then
        inst_reqs=$(sed -n "/<< 'REQEOF'/,/^REQEOF/p" install-darjeeling.sh | sed '1d;$d' | sort)
        file_reqs=$(grep -vE '^\s*(#|$)' server/requirements.txt | sort)
        if [ -n "$inst_reqs" ] && [ "$inst_reqs" != "$file_reqs" ]; then
            diff <(printf '%s\n' "$file_reqs") <(printf '%s\n' "$inst_reqs") >"$LOGS/requirements-drift.diff"
            record WARN server:requirements-drift 0 "install-darjeeling.sh inlines a different list than server/requirements.txt"
        else
            record PASS server:requirements-drift 0 "installer and requirements.txt agree"
        fi
    else
        record PASS server:requirements-drift 0 "requirements locked"
    fi

    if compgen -G "tests/server/test_*.py" >/dev/null || compgen -G "server/tests/test_*.py" >/dev/null; then
        # DJ_LAB_PYTEST_ARGS is split on purpose, e.g. "--runxfail -k history".
        # shellcheck disable=SC2086
        run server-pytest "$PY" -m pytest -q -rfExX -p no:cacheprovider \
            --junitxml="$OUT/pytest.xml" ${DJ_LAB_PYTEST_ARGS:-} tests/server
        line=$(grep -E '^(=+ )?[0-9]+ (passed|failed)|[0-9]+ (passed|failed|error)' "$LOGS/server-pytest.log" | tail -n 1 | tr -d '=' | sed 's/^ *//')
        if [ "$RC" -eq 0 ]; then
            record PASS server:pytest "$SECS" "$line"
        else
            record FAIL server:pytest "$SECS" "$line"
        fi
    else
        record WARN server:pytest 0 "no server tests found"
    fi
fi

# ------------------------------------------------------------------ shell
if want shell; then
    cd "$W" || exit 1
    mapfile -t shfiles < <(list_shell_files | sort)
    t0=$SECONDS
    shellcheck -x -f json1 "${shfiles[@]}" >"$OUT/shellcheck.json" 2>"$LOGS/shellcheck.stderr"
    shellcheck -x -f gcc "${shfiles[@]}" >"$LOGS/shellcheck.log" 2>&1
    SECS=$((SECONDS - t0))
    counts=$(python3 - "$OUT/shellcheck.json" <<'PY'
import json, sys, collections
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    print("parse-error"); sys.exit()
c = collections.Counter(x["level"] for x in data.get("comments", []))
per = collections.Counter(x["file"] for x in data.get("comments", []) if x["level"] in ("error", "warning"))
print("error=%d warning=%d info=%d style=%d" % (c["error"], c["warning"], c["info"], c["style"]))
print(" ".join("%s:%d" % (f.lstrip("./"), n) for f, n in per.most_common()))
PY
)
    summary=$(printf '%s\n' "$counts" | sed -n 1p)
    worst=$(printf '%s\n' "$counts" | sed -n 2p)
    errs=$(printf '%s' "$summary" | sed -nE 's/.*error=([0-9]+).*/\1/p')
    warns=$(printf '%s' "$summary" | sed -nE 's/.*warning=([0-9]+).*/\1/p')
    if [ "${errs:-1}" -eq 0 ] && [ "${warns:-1}" -eq 0 ]; then
        record PASS shellcheck "$SECS" "${#shfiles[@]} files, $summary"
    else
        record FAIL shellcheck "$SECS" "${#shfiles[@]} files, $summary [$worst]"
    fi
fi

echo "---"
printf 'RESULT: %s  (%d fail, %d warn)\n' "$([ "$FAILS" -eq 0 ] && echo PASS || echo FAIL)" "$FAILS" "$WARNS"
[ "$FAILS" -eq 0 ]
