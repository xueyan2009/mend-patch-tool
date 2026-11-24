# mend — build log

Competition: hidden-spec-cli-01-run-20261122 ("Build mend, one patch tool for every AI edit format").
Built 2026-11-24 from the kit starter (starter files copied in unchanged first, then main.ts implemented).

## What was implemented (all in main.ts, on top of the starter)

The starter already covered SPEC sections 1–4, 9 and 10 (CLI parsing, exit-2 precedence, safe paths,
format detection, JSON edits, all-or-nothing writes). Kept that behaviour and added:

- **Section 5 matching tiers** — tier 0 exact, tier 1 trailing spaces/tabs trimmed, tier 2 leading+trailing
  trimmed; first tier with an occurrence wins; `--strict` restricts to tier 0. Context lines are written
  back as the file's own matched lines; at tier 2, non-context new lines are re-indented by replacing the
  old block's leading whitespace P with the file's first matched line's F.
- **Section 6 unified diffs** — sections from `diff --git` or `--- `/`+++ ` pairs, header paths (tab cut,
  `a/`/`b/` stripped, `/dev/null`), rename from/to, new/deleted file mode, ignored header lines, malformed
  `diff --git`/`@@`/`---` lines as parse errors with the SPEC's line numbers. Hunks apply in order with the
  running offset d; the occurrence nearest to A-1+d wins (earlier on ties); empty-O hunks insert after
  A+d lines. Deletion hunks are not read. The `\ No newline` rule of section 6 drives the result's final
  line break whenever a hunk touches the end of the file, and for created files.
- **Section 7 SEARCH/REPLACE** — marker lines matched with trailing whitespace removed; path is the
  nearest preceding non-blank, non-fence line after the previous block (falling back to the previous
  block's path; first block without one is a parse error at its SEARCH line); a block missing `=======`
  or `>>>>>>> REPLACE` is a parse error at its SEARCH line. Empty old lines create the file; otherwise
  the old lines must occur exactly once at their tier, else `ambiguous`.
- **Section 8 V4A** — Begin/End Patch validation with the SPEC's parse line numbers; Add/Delete/Update
  sections; Move to; anchored chunks with a cursor (anchor matched line-wise at the first tier that has
  one at/after the cursor); end-of-file chunks via `*** End of File` (only occurrences ending at the
  file's last line); blank lines at a section's end are not part of it; an Update section with no chunk
  and no Move to is a parse error at its line.
- **Section 2 move output** — successful move edits print one `R <old> -> <new>` line (sorted by the new
  path) instead of separate D and A lines, and count as one file in `ok: <n>`.

## Test results

- Practice set (`node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json`):
  first full run 97/100 — two bugs fixed (creation sections misread as deletions because the /dev/null
  test looked at the old path; a V4A section-final single-space blank line was kept as a context line).
  After the fixes: **100 of 100 passed, practice score 1000**.
- Kit grade-local, process driver: trial 0 score 1000 (unified 30, search_replace 20, v4a 20, json 15,
  cli 15, working 1), replay matched. With `--instances 3`: all 3 practice trials finished, mean score
  1000, 0 nondeterministic.
- 28 additional self-written edge cases against SPEC sentences the practice families do not show
  (usage-error precedence, `--` handling, git-only section paths, header parse errors, end-of-file
  break rules with and without `\`, unsafe move target naming, SEARCH/REPLACE path reuse and chained
  edits, tier-2 re-indentation, V4A pure move / EOF-chunk failures / `--check` move, JSON array and
  JSONL fault line numbers, JSON insert into a CRLF file): 28/28 passed.

Nothing was submitted; no API key, wallet or GitHub account was used.
