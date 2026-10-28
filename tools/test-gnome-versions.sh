#!/usr/bin/env bash
# Runs tools/test-shell.sh (with screenshots) against several GNOME
# versions, each in a Fedora container. Containers are limited in memory
# and CPU, run one at a time, and are removed afterwards.
#
# Usage: tools/test-gnome-versions.sh [out-dir] [fedora versions...]
#        default: build/gnome-versions, Fedora 41 42 43 44 (GNOME 47-50)

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/build/gnome-versions}")
shift $(( $# > 0 ? 1 : 0 ))
if [ $# -gt 0 ]; then VERSIONS=("$@"); else VERSIONS=(41 42 43 44); fi

declare -A RESULTS
for fedora in "${VERSIONS[@]}"; do
    image="earful-test:fedora$fedora"
    echo "== Fedora $fedora: building image (first time downloads GNOME)"
    if ! docker build -q --build-arg FEDORA="$fedora" -t "$image" \
        "$ROOT/tools/gnome-versions" >/dev/null; then
        RESULTS[$fedora]="image build failed"
        continue
    fi
    gnome=$(docker run --rm "$image" gnome-shell --version 2>/dev/null)
    echo "== Fedora $fedora: $gnome"

    dir="$OUT/fedora$fedora"
    rm -rf "$dir"
    mkdir -p "$dir"
    chmod 777 "$dir"
    # The repo is mounted read-only and copied, so the test can build in it.
    # The shell expects a system bus, so one is started (as root) before
    # the test runs as a normal user.
    docker run --rm --memory 2g --cpus 4 --user root \
        -v "$ROOT:/src:ro" -v "$dir:/out" "$image" bash -c '
            mkdir -p /run/dbus && dbus-daemon --system --fork
            runuser -u tester -- bash -c "
                mkdir -p \$XDG_RUNTIME_DIR && chmod 700 \$XDG_RUNTIME_DIR
                cd && cp -r /src earful && cd earful && rm -rf dist
                SHOTS=/out/shots timeout 400 tools/test-shell.sh
            "
        ' > "$dir/test.log" 2>&1
    status=$?
    RESULTS[$fedora]="$gnome: $([ $status -eq 0 ] && echo PASS || echo "FAIL (see $dir/test.log)")"
    echo "== Fedora $fedora: ${RESULTS[$fedora]}"
done

echo
for fedora in "${VERSIONS[@]}"; do
    echo "Fedora $fedora  ${RESULTS[$fedora]}"
done
