#!/bin/sh
# Container entrypoint.
#
# `exec` on the last line matters: it makes node PID 1's direct successor, so
# SIGTERM reaches the app and the graceful shutdown path runs (closing the pool
# and stopping the Python RAG child). Without it a shell swallows the signal and
# the container is SIGKILLed after the timeout, leaking the Python process.
set -e

# Migrations are guarded by a PostgreSQL advisory lock, so running this on every
# container start is safe even with several replicas booting at once.
# Set RUN_MIGRATIONS=false to run them as a separate release step instead.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  node src/scripts/migrate.js
fi

exec "$@"
