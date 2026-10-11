# Chrome Web Store listing (copy-paste)

## Name
Job Form Filler

## Summary (max 132 chars)
Fill job application forms from your local profile in seconds. Never auto-submits. Optional AI for custom questions.

## Category
Productivity

## Description
Stop retyping the same details into every job application.

Job Form Filler fills the standard fields on Ashby, Greenhouse, Lever, Workable and LinkedIn Easy Apply from a profile stored only in your browser: name, contacts, links, work authorization, notice period, EEO answers and your resume file. Works in many languages.

How it works
• Fill your profile once (or import it).
• Open an application form and click "Fill standard fields".
• Review what was filled. The extension highlights it and tells you what is missing.
• You press Submit. The extension never does.

Optional: connect an AI assistant (Claude Code or Claude Desktop via MCP) to answer only the custom questions, using a compact job summary instead of raw page dumps or screenshots. Motivation and behavioural questions are never auto-written. They are returned to you.

Privacy
• No accounts, no tracking, no analytics.
• Your profile and resume stay in your browser. The extension sends nothing to the developer.
• Open source: https://github.com/MIt9/job-form-filler

## Single purpose
Fill job application forms with the user's own saved profile data.

## Permission justifications
- **storage:** stores the user's profile and settings locally.
- **activeTab, scripting:** reads and fills the form on the tab where the user triggers the extension.
- **tabs, webNavigation:** finds the application tab and its iframes (many applicant tracking systems embed forms).
- **alarms:** keeps the connection to the optional local bridge alive.
- **Host permissions (ashbyhq.com, greenhouse.io, lever.co, workable.com, linkedin.com):** the content script runs on these job boards.
- **localhost / 127.0.0.1:** communication with the optional local bridge on the user's machine.
- **Optional `<all_urls>`:** only if the user enables "Work on any website" for custom career pages. Revocable in chrome://extensions.
- **Remote code:** none. All code ships in the package.

## Data usage disclosures (dashboard checkboxes)
- Collects: Personally identifiable information, website content. Both are used only locally to fill forms.
- Not sold, not used for unrelated purposes, not used for creditworthiness.
- Privacy policy URL: https://github.com/MIt9/job-form-filler/blob/main/docs/PRIVACY.md

## Assets to prepare
- Icon 128×128: `extension/icons/icon128.png` (done)
- Screenshots 1280×800 (1 to 5): popup with profile, form before/after fill, fill report, Settings tab
- Small promo tile 440×280 (optional but improves placement)
- Demo video (YouTube link, optional): see `docs/demo-script.md`
