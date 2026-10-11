# Privacy Policy: Job Form Filler

_Last updated: 2026-10-11_

Job Form Filler is a Chrome extension (and optional local MCP server) that fills job application forms from a profile you enter yourself.

## What data the extension handles
- **Profile data you type in:** name, contact details, links, work-authorization answers, optional EEO answers, and a resume file you upload.
- **Page content of job application forms** you ask it to fill: field labels and options, read locally in the page to match them to your profile.

## Where it is stored
- Everything is stored **locally in your browser** (`chrome.storage.local`). You can export, edit or delete it at any time in the popup, or by removing the extension.

## What is sent, and to whom
- **The extension itself sends no data to the developer or any third-party server.** It has no analytics, tracking, ads or remote code.
- It communicates only with a **local bridge on your own computer** (`127.0.0.1`, default port 8765), and only if you chose to run it.
- If you connect an AI assistant (for example Claude through MCP) or set `ANTHROPIC_API_KEY` for the bridge, the unfilled custom questions and a job summary go to **that provider under your own account and its terms**. This is optional and off by default.

## Permissions
| Permission | Why |
|---|---|
| `storage` | Keep your profile and settings locally. |
| `activeTab`, `scripting` | Read and fill the form on the tab where you click the extension. |
| `tabs`, `webNavigation` | Find the application tab and its frames (many ATS embed forms in iframes). |
| `alarms` | Keep the connection to the optional local bridge alive. |
| Host access to `ashbyhq.com`, `greenhouse.io`, `lever.co`, `workable.com`, `linkedin.com` | Run the form filler on these job boards. |
| `localhost` / `127.0.0.1` | Talk to the optional local bridge. |
| `<all_urls>` (optional, off by default) | Only if you enable "Work on any website" for custom career pages. You can revoke it any time in `chrome://extensions`. |

## Safety
The extension never clicks the final Submit button. You review and submit yourself.

## Children
Not directed at children.

## Contact
Questions or deletion requests: open an issue at https://github.com/MIt9/job-form-filler/issues
