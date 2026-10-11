#!/bin/sh
# Build Chrome Web Store zip from extension/ and tag it. Usage: npm run release:extension
# Upload dist/job-form-filler-ext-<version>.zip manually at https://chrome.google.com/webstore/devconsole
set -eu
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
v=$(node -p "require('./extension/manifest.json').version")
git rev-parse "ext-v$v" >/dev/null 2>&1 && { echo "tag ext-v$v already exists, bump manifest version"; exit 1; }
npm test
mkdir -p dist
out="dist/job-form-filler-ext-$v.zip"
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '*.DS_Store')
git tag "ext-v$v"
git push origin HEAD "ext-v$v"
echo "built $out"
