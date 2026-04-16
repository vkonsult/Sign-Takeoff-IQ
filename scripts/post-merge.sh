#!/bin/bash
set -e
pnpm install --frozen-lockfile
cd lib/db && npx tsc --build && cd ../..
pnpm --filter db push
