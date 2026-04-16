#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db build
pnpm --filter db push
