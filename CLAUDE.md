# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and AGY (Antigravity CLI) when working with code in this repository.

## Project Overview

`job-form-filler` is a hybrid 0-token and AI-assisted Chrome Extension + Local Bridge / MCP server designed to eliminate massive token waste when filling job application forms across ATS platforms (Ashby, Greenhouse, Lever, Workable, LinkedIn Easy Apply).

### Key Architectural Concepts

1. **Two-Tier Field Processing**:
   - **Tier 1 (0 Tokens)**: Instant local matching and DOM autofill for candidate's static data (Name, Email, Phone, Location, Portfolio, LinkedIn, GitHub, Work authorization, Notice period). Zero API calls and zero tokens spent.
   - **Tier 2 (Minimal Token AI)**: Extracts only custom/unfilled questions (e.g., Cover letter, "Why this role?", custom screening questions) alongside a clean, compressed job summary. Eliminates 95% of token overhead by avoiding raw DOM dumps or Vision screenshots.
2. **Safety Rule**:
   - Never auto-clicks the final "Submit Application" button. Highlights filled fields and requires human review.
3. **Profile = single source of truth in the extension**:
   - Candidate data is edited in the popup (stored in `chrome.storage.local`); the repo ships no personal data. The schema and editor fields live in `extension/shared/default-profile.js` (`PROFILE_FIELDS`).
   - MCP reads it via the bridge (`GET_PROFILE`). Optional `RESUME_REPO_PATH` (opt-in, no default location) adds role variants (resume markdown + PDF) and saves applications to `<role>/applications/<company>/`.
4. **Bridge accepts only the extension and local processes** (`isTrustedRequest`): never reintroduce `CORS *` or a `0.0.0.0` bind.

## Directory Structure

```
job-form-filler/
├── extension/             # Chrome Extension (Manifest V3)
│   ├── manifest.json      # Extension manifest
│   ├── popup/             # Extension UI (popup.html, popup.js, popup.css)
│   ├── content/           # Content scripts (DOM detection, autofill, AI injection)
│   ├── background/        # Service worker (WebSocket connection to bridge)
│   ├── shared/            # Candidate profile defaults & shared definitions
│   └── icons/             # PNG icons (16, 48, 128)
├── server/                # Node.js backend
│   ├── bridge-server.js   # HTTP + WebSocket bridge (port 8765)
│   ├── mcp-server.js      # Model Context Protocol stdio server
│   ├── profile-loader.js  # Role variants reader from RESUME_REPO_PATH
│   ├── job-posting.js     # Server-side ATS & generic job posting fetcher
│   ├── app-saver.js       # Application saver for RESUME_REPO_PATH
│   └── ai-generator.js    # Grounded answer generator
├── bin/
│   ├── bridge.js          # CLI executable to start bridge server
│   └── mcp.js             # CLI executable to run MCP server
├── test/
│   └── test-profiles.js   # Unit tests
└── package.json
```

## Common Commands

- Run unit tests: `npm test`
- Start Bridge Server: `npm run bridge` (runs on `http://127.0.0.1:8765` and `ws://127.0.0.1:8765/ws`)
- Run MCP Server: `npm run mcp`
