#!/bin/sh
set -eu

case "$(uname -m)" in
  aarch64|arm64)
    exec node node_modules/.bin/tsx "$@"
    ;;
  *)
    exec bun run --sequential "$@"
    ;;
esac
