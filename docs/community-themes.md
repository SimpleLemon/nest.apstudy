# Community themes

The gallery starts empty. No theme records are seeded or published by this change.

- `/themes`: approved gallery, search, category filters, light/dark previews and share pages.
- `/themes/new`: signed-in creation or import from APStudyCanvas settings JSON. Import retains only portable appearance settings; personal data, course overrides, custom CSS, backgrounds and GIFs are excluded.
- `/themes/mine`: the current author's drafts and submissions.
- `/themes/<id>`: stable public share link. Remixing pins attribution to the approved source revision.
- `/admin/themes`: existing Nest admin permission required. Review pending revisions, compare the current public version, inspect earlier revisions/settings and actor history, approve, reject with a reason, unpublish with a reason, and resolve reports.

Authors save private drafts before submitting. Pending submissions are immutable; withdraw before editing. Every update needs fresh approval. A previous approved version remains public while its replacement is drafted, reviewed or rejected. Admin unpublishing immediately removes public API and share-page access. Reports never appear in public responses.

The editor supports both palettes, packaged fonts and course-card styling. Conversion generates the opposite palette while preserving hue and correcting text contrast; it overwrites only that destination palette after confirmation. Previews use illustrative course cards, not personal Canvas content. Low contrast is flagged for author and admin review.

APStudyCanvas's Themes section browses approved entries anonymously, previews either palette without changing saved preferences, and imports an approved revision through its existing settings transaction. Applying a preview saves the selected mode. Reload Canvas if the current page has not updated. The Appearance option for community light palettes restores Canvas's default light colors when turned off.

Deployment uses Nest's existing database migration runner (`026_community_themes.sql`) and existing authentication/admin access. All mutation routes require a signed-in session and CSRF protection. Portable theme documents contain no executable CSS, remote fonts or media. The extension and server share a versioned schema. Keep `static/js/community-themes/core.js` in sync with APStudyCanvas's `js/community-theme-core.js`.

Local checks: `PYTHONPATH=<optional local dependencies> .venv/bin/python -m unittest tests.test_community_themes tests.test_accessibility_baseline`, `npm test`, `npm run build`. The local browser fixture used for development is not installed in the application or routed by Nest.
