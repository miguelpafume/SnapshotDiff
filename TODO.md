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

## Whole lines highlighted when a lot was edited

When a sentence or paragraph has many edits, the highlight still turns the whole line (or most of it) green/red instead of marking only the changed words.

- [ ] Collect a few real examples (snapshot text + current text) that show it, so each fix can be checked against them. `wordDiff.ts` has no Obsidian imports, so they can run as a small script outside the app.
- [ ] Find which step causes it for each example: `absorbShortEqualities` folding too much, the patched `makePresentable` / `mergeAdjacent` in `@codemirror/merge`, or the diff giving up (`wordDiff` runs with a time limit; the library falls back to an imprecise diff, see "fell back to fast, imprecise diffing" in its source).
- [ ] Tune the rule rather than drop it: the folding is what keeps a rewritten sentence from showing stray "the"/"and" as unchanged, so the examples should cover both cases.

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
