# TODO

## Add artifact attestations to releases

The community directory recommends it: "Missing GitHub artifact attestations for release assets (main.js, styles.css)". An attestation is a signed record, stored by GitHub, proving each release file was built by the release workflow from this repo at the tagged commit. Anyone can check a download with `gh attestation verify main.js --repo miguelpafume/SnapshotDiff`. It's free for public repos.

- [ ] In `.github/workflows/release.yml`, add to `permissions`: `id-token: write` and `attestations: write` (keep `contents: write`).
- [ ] After `npm run build` and before "Draft release", add a step with `actions/attest-build-provenance` (latest major was v4 in Oct 2026; check its README for the current inputs), with `subject-path` set to `snapshot-diff/main.js`, `snapshot-diff/manifest.json` and `snapshot-diff/styles.css`.
- [ ] Also update `actions/checkout` and `actions/setup-node`. v4 of both still runs on Node 20, which GitHub has deprecated; check each one's release notes for breaking changes.
- [ ] Release a new patch version. Attestations only apply to files built after the change, so 1.0.5 and older stay unsigned.
- [ ] Check it worked: download `main.js` from the new release and run `gh attestation verify`.

Docs: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds

## Jump to next/previous edit in the diff view

A button and a hotkey to move between changes, so long notes don't need scrolling to find the next edit.

- [ ] `@codemirror/merge` already exports `goToNextChunk` and `goToPreviousChunk` (commands that move the cursor to the next/previous chunk and scroll to it). Run them on whichever pane has focus, or pane `b` if neither does.
- [ ] Register "Go to next change" / "Go to previous change" with `addCommand` and `checkCallback`, so they only show up while a diff tab is active and users can bind their own hotkeys. Default hotkeys are discouraged for community plugins, so leave them unset (or check what Obsidian's reviewers accept).
- [ ] Add up/down arrow buttons to the view header with `addAction`, next to the existing actions.
- [ ] Decide what happens at the last change: wrap around to the first, or stop. Maybe show "Change 3 of 12" somewhere.

## Smaller chunks for "revert this chunk"

The revert arrows act on whole chunks, which are sometimes too big to be useful.

- [ ] Cause: the library's `toChunks` groups changes by line. Any changes on the same or adjacent lines become one chunk, and in Obsidian a paragraph is usually one long line, so every edit in a paragraph (and in the paragraphs right next to it) is reverted together.
- [ ] Options to weigh:
  - Split chunks at sentence boundaries or blank lines instead of only at line gaps. `toChunks` isn't configurable, so this means another patch to `@codemirror/merge` (see the patch notes in CLAUDE.md) or building the chunks ourselves.
  - Revert per change: a small control on each changed word/phrase (on hover, or a right-click "Revert this change"), keeping the chunk arrow for the whole block.
  - Revert the selection: select text in pane `b` and revert only the changes inside it.
- [ ] Whatever the split, the revert has to go through the same save path as typing in pane `b` (debounced `vault.process`) and stay undoable with Ctrl+Z.

## Resizable panes (drag the middle divider)

Let the user drag the vertical bar between the snapshot and the note to make one pane wider than the other.

- [ ] Layout today: `.cm-mergeViewEditors` is a flex row and both `.cm-mergeViewEditor` panes have `flex-grow: 1; flex-basis: 0`, so they always split 50/50. When revert controls are on, the `.cm-merge-revert` column (1.6em) sits between them; otherwise the divider is just the `border-left` from `styles.css`.
- [ ] Add a drag handle on the divider (the revert column when it's shown, a thin added element otherwise). On pointer drag, set the left pane's `flex-grow` (or `flex-basis` as a percentage) and the right pane's to match. Use pointer capture, a `col-resize` cursor, and a minimum width so neither pane can collapse. Double-click resets to 50/50.
- [ ] Wrapped lines change height when a pane gets narrower, so the panes have to stay aligned during and after a drag. Check that the merge view re-aligns them; if not, call `requestMeasure()` on both editors after resizing.
- [ ] Decide where to keep the ratio: per tab in the view state (`getState`/`setState`, so it survives a restart), as one setting for every diff tab, or both (a setting for the default, the tab keeps any drag).
- [ ] The tab still has to work on mobile and in narrow sidebars: touch dragging, and a sensible minimum pane width.

## Typing lag on long notes

With every line drawn (`drawAll`), each keystroke still costs more on long notes. On a 900-line, 60k-character note it's acceptable; with a few thousand lines typing lags and the occasional keystroke freezes. The cost grows with the number of lines, not characters.

- [ ] What's done:
  - `measureChangedLinesOnly` (`src/lineHeights.ts`) re-measures only the lines that changed. In the test page (3,000 short lines, 125% scaling) that took latency from ~34 ms to ~25 ms.
  - The merge view's alignment passes (`updateSpacers`, `updateRevertButtons`) looked up each chunk's line with a scan over every drawn line, so they cost lines × chunks. The `@codemirror/merge` patch now binary-searches instead (same result). With 300 chunks in 3,000 lines that took ~58 ms to ~33 ms; with few chunks it makes no difference. Starting those passes at the edited chunk was the original idea, but after this fix both together cost under 1 ms, so it wasn't worth the risk to the alignment.
- [ ] Where the rest goes (same test, few chunks): the browser's layout and paint of the whole drawn note (~20 ms, the largest part), the gutters (line numbers and change bars, ~8–10 ms). The diff itself is ~0.5 ms. When an edit changes a spacer (a line wraps differently), the spacer update is one more editor update with its own layout. About 2 keystrokes in 40 take ~70 ms, inside the browser's frame rendering, not plugin code.
- [ ] Ruled out: lazy drawing in any form, including "measure everything once, then draw lazily". It passed the test page but brought the jitter back in Obsidian.
- [ ] Ideas not yet taken:
  - A setting to turn line numbers off (no gutters at all saved ~8–10 ms). Line numbers drawn with a CSS counter instead gave back ~5 ms of that.
  - Optional: replace CodeMirror's line-number gutter with our own. Its `syncGutters` walks every drawn line on each update; ours would update only the lines whose number or height changed (Enter or deleting a line still renumbers everything below). Maybe a bit more than the CSS counter's ~5 ms; unmeasured.
  - Something that cuts the browser's per-frame layout/paint without lazy drawing, e.g. CSS containment on lines. Untested; `content-visibility` is lazy rendering in disguise, so probably out.
- [ ] Measure with the scroll test page from the `lazy-drawing` branch (`tools/scroll-test`). It needs extending again first (the version used for the numbers above was only a temporary copy): short-line notes, real keystroke latency (dispatch to the second animation frame), and CPU profiles over CDP. Runs on this machine vary 2–3× between fast and slow states, so interleave the variants and compare medians.
