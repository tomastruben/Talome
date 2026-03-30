#!/bin/sh
# Start dashboard (Next.js standalone) in background on port 3000
PORT=3000 HOSTNAME=0.0.0.0 node /app/dashboard/apps/dashboard/server.js &

# Start core (main process — tini manages this)
exec node /app/core/dist/index.js
