## 2025-05-18 - Accessibility for Dynamic Action & Title Editing Icon Buttons
**Learning:** Icon-only action controls (such as title editing/saving or modal dismissal buttons) in EJS view templates can lack screen reader accessibility if only given `title` or visual SVG icons.
**Action:** Always complement icon-only buttons with explicit, localized `aria-label` attributes describing the exact action (e.g. `aria-label="Edit title"`, `aria-label="Close message drawer"`).
