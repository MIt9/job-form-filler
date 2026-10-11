#!/bin/sh
# Publish MCP + bridge to npm and tag the release. Usage: npm run release:mcp
set -eu
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
v=$(node -p "require('./package.json').version")
git rev-parse "mcp-v$v" >/dev/null 2>&1 && { echo "tag mcp-v$v already exists, bump package.json version"; exit 1; }
npm test
npm publish --access public
git tag "mcp-v$v"
git push origin HEAD "mcp-v$v"
echo "published job-form-filler@$v"
