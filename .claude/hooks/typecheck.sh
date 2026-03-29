#!/bin/bash
# Typecheck after editing TypeScript files.
# Only blocks if the EDITED file has errors (ignores pre-existing errors in other files).
# Exit 0 = pass, exit 2 = block (shows stderr to Claude).

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only run for TypeScript files
if [[ "$FILE_PATH" != *.ts ]] && [[ "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)" || exit 0
cd "$ROOT" || exit 0

# Get the relative path from repo root for matching against tsc output
REL_PATH="${FILE_PATH#$ROOT/}"

if [[ "$FILE_PATH" == *apps/core/* ]]; then
  OUTPUT=$(apps/core/node_modules/.bin/tsc --noEmit -p apps/core/tsconfig.json 2>&1)
elif [[ "$FILE_PATH" == *apps/dashboard/* ]]; then
  OUTPUT=$(apps/dashboard/node_modules/.bin/tsc --noEmit -p apps/dashboard/tsconfig.json 2>&1)
else
  exit 0
fi

# Filter errors to only those in the edited file
RELEVANT=$(echo "$OUTPUT" | grep "^$REL_PATH")

if [ -n "$RELEVANT" ]; then
  echo "$RELEVANT" >&2
  echo "TypeScript errors in edited file — fix before continuing." >&2
  exit 2
fi

exit 0
