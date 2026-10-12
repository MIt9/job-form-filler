#!/bin/sh
# Build the one-click Claude Desktop bundle: dist/job-form-filler-<version>.mcpb. Usage: npm run build:mcpb
set -eu
cd "$(dirname "$0")/.."
v=$(node -p "require('./package.json').version")
b=dist/mcpb-build
rm -rf "$b" && mkdir -p "$b/extension"
cp -R bin server package.json package-lock.json "$b/"
cp -R extension/shared "$b/extension/shared"
cp extension/icons/icon128.png "$b/icon.png"
(cd "$b" && npm ci --omit=dev --silent)
node scripts/mcpb-manifest.js "$b"
npx -y @anthropic-ai/mcpb validate "$b/manifest.json"
npx -y @anthropic-ai/mcpb pack "$b" "dist/job-form-filler-$v.mcpb"
echo "built dist/job-form-filler-$v.mcpb"
