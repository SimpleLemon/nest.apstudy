# Frontend browser testing

The Playwright suite covers keyboard interaction, modal focus, responsive layouts, theme and reduced-motion behavior, dynamic contrast, CSP, touch targets, text resizing, and horizontal overflow.

## Local run

Start the Flask application in one terminal:

```sh
.venv/bin/flask --app app:create_app run --host 127.0.0.1 --port 8000
```

Then run the complete browser suite:

```sh
npm run test:browser
```

To use another already-running server, set `PLAYWRIGHT_BASE_URL`:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:9000 npm run test:browser
```

Focused runs can pass a spec path directly to Playwright, for example `npx playwright test tests/browser/onboarding-keyboard.spec.mjs`.

## CI run

CI should install the pinned npm and Python dependencies, install Chromium with `npx playwright install --with-deps chromium`, start the Flask server, wait until `/` responds, and run `npm run test:browser`. Preserve the Playwright report and `test-results/` directory when a run fails.

The suite expects a local application server and must not target production. Unexpected page errors and console errors are test failures in the cross-surface quality matrix.
