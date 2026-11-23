# Drift: notes for agents

## Editing code
- Use the Edit tool for any change to code that has backslashes or quotes in it (regexes, escaped strings, scripts inside
  strings). Don't push code through Python, sed, `node -e` or JSON heredocs: each adds a layer of escaping, and a lost `\`
  only shows up at runtime. If a one-off script is really needed, write it to a file with Write and run the file.
- Keep each file's line endings (most are CRLF). `sed -i` turns a CRLF file into LF.

## In-app tests (`runShots` in main.js, driven by `scripts/test-*.js`)
- Drive a page with `pageRun(wc, fn, ...args)`: `fn` is a real function, run in the page with `args` passed as JSON. It's
  checked with the rest of main.js by `node --check`, and nothing is escaped twice. It can't see main.js's variables: pass
  them in.
  ```js
  const text = await pageRun(wc, (sel) => document.querySelector(sel).innerText.replace(/\n+/g, ' | '), '#callBar');
  ```
- Never call `webContents.executeJavaScript` directly. Older tests pass strings to `pageJs(wc, code)` (or the `js(code)`
  helpers built on it), which checks the syntax first, so a broken script fails at once with the real reason, not Electron's
  "Script failed to execute".
- `node --check main.js` before any run. The end-to-end tests start several copies of Drift and take a while. For a styling
  change, check the CSS and the numbers instead of running them.
- Fail fast. In a test, a check that everything after it depends on (the hub comes up, the stream connects) uses
  `need(name, ok)` instead of `tl(name, ok)`: if it fails, it writes an `abort` marker and every wait on every copy gives up at
  once, rather than each running out its own timeout. The Surf stream test (`DRIFT_TESTSS`) does this, and a failure there
  stops in about a minute; copy its `until`/`need`/`abort` lines when touching another test.
- Run a test with a shell `timeout` a little over its normal time (`timeout 240 node scripts/test-surf-stream.js`), never a
  10-minute cap.
- Test windows are hidden (`DRIFT_HIDDEN`): CSS transitions and animations don't run there, and `capturePage` screenshots
  can be stale. To measure a layout, turn transitions off first. Don't rely on screenshots.
