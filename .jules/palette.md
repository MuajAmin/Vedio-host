## 2025-08-31 - Icon-Only Buttons and Interactive Profile Elements Require Explicit ARIA Labels
**Learning:** Icon-only navigation control elements (`#themeSwitcherNavBtn`, `#themeSwitcherBtn`) and custom interactive badges (`#profileBadgeBtn`) were using `title` or `role="button"` without explicit `aria-label` attributes, leading to degraded accessibility on screen readers.
**Action:** Always provide explicit, descriptive `aria-label` attributes on icon-only control buttons and custom interactive elements across all view templates.
