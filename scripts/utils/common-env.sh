#!/usr/bin/env bash

#
# helpers
#

load_env_var() {
  local name="$1"
  local default="${2-}"

  # try load from env
  if [[ -n "${!name:-}" ]]; then
    export "$name"
    return 0
  fi

  # try load from .env
  if [[ -f .env ]]; then
    local value
    value="$(
      set -a
      . ./.env
      printf '%s' "${!name:-}"
    )"

    if [[ -n "$value" ]]; then
      export "$name=$value"
      return 0
    fi
  fi

  # use default value if provided
  if [[ $# -ge 2 ]]; then
    export "$name=$default"
    return 0
  fi

  return 1
}
