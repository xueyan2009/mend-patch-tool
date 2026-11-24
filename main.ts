// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line, output and exit
// codes, safe paths, format detection, the three matching tiers, unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  noteMove(from: string, to: string): void {
    this.moves.push([from, to] as const);
  }
}

type Edit = (tree: Tree) => void;

/** A file's text as its lines, its own line break, and whether it ends with that break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinLines(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

// ---- Matching lines (SPEC.md section 5) ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every position at which O occurs in `lines` at `tier` (occurrences may overlap). */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  outer: for (let i = 0; i + O.length <= lines.length; i += 1) {
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** The first tier (0 only when strict) at which O occurs, with its occurrences, or null. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const occ = occurrences(lines, O, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** One hunk/chunk body entry: ' ' context, '-' old, '+' new, '\\' the no-newline marker. */
interface BodyLine {
  k: string;
  t: string;
  emptySrc: boolean;
}

const oldLinesOf = (body: BodyLine[]): string[] => body.filter((b) => b.k === ' ' || b.k === '-').map((b) => b.t);
const newCountOf = (body: BodyLine[]): number => body.filter((b) => b.k === ' ' || b.k === '+').length;

/**
 * The lines a matched body writes in place of the file's lines at `pos`: context lines are the file's own matched
 * lines; at tier 2 every other new line is re-indented (SPEC.md section 5).
 */
function buildOutput(body: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const O = oldLinesOf(body);
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  const out: string[] = [];
  let mi = 0;
  for (const b of body) {
    if (b.k === ' ') {
      out.push(fileLines[pos + mi]!);
      mi += 1;
    } else if (b.k === '-') {
      mi += 1;
    } else if (b.k === '+') {
      let t = b.t;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6). */
function backslashAfterLastWritten(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.k === ' ' || b.k === '+') last = i;
  });
  return last >= 0 && body[last + 1]?.k === '\\';
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  oldRaw?: string;
  newRaw?: string;
  sawPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path of a `--- `/`+++ ` line: after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return rest.trim();
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const startsSection = (i: number): boolean =>
    lines[i]!.startsWith('diff --git ') || (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
  const newSection = (): USection => {
    const s: USection = { sawPair: false, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const isDeletion = (s: USection): boolean =>
    s.deletedFile || (s.newRaw !== undefined && stripPrefix(s.newRaw) === '/dev/null');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.sawPair) cur = newSection();
      cur.oldRaw = headerPath(line);
      cur.newRaw = headerPath(lines[i + 1]!);
      cur.sawPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number.parseInt(hm[1]!, 10);
      i += 1;
      if (isDeletion(cur)) {
        // A deletion's hunks are not read: skip to the next section.
        while (i < lines.length && !startsSection(i)) i += 1;
        cur.hunks.push({ a, body: [] });
        continue;
      }
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          body.push({ k: ' ', t: '', emptySrc: true });
          i += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ k: c, t: l.slice(1), emptySrc: false });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.k === ' ' && body[body.length - 1]!.emptySrc) body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks to a file's text; a hunk failure fails the section with that hunk's code. */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  let lines = f.lines;
  let finalBreak = f.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const O = oldLinesOf(h.body);
    const plus = h.body.filter((b) => b.k === '+').map((b) => b.t);
    if (O.length === 0) {
      const pos = Math.min(h.a + d, lines.length);
      lines = [...lines.slice(0, pos), ...plus, ...lines.slice(pos)];
      if (pos === lines.length - plus.length && plus.length > 0) {
        finalBreak = !backslashAfterLastWritten(h.body);
      }
      d += plus.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const out = buildOutput(h.body, lines, pos, found.tier);
    const runsToEnd = pos + O.length === lines.length;
    lines = [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
    if (runsToEnd) finalBreak = !backslashAfterLastWritten(h.body);
    d += newCountOf(h.body) - O.length;
  }
  return joinLines(lines, f.br, finalBreak);
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldP = s.oldRaw !== undefined ? stripPrefix(s.oldRaw) : undefined;
  let newP = s.newRaw !== undefined ? stripPrefix(s.newRaw) : undefined;
  if (oldP === undefined && s.renameFrom !== undefined) oldP = s.renameFrom;
  if (newP === undefined && s.renameTo !== undefined) newP = s.renameTo;
  if (oldP === undefined && s.gitOld !== undefined) oldP = s.gitOld;
  if (newP === undefined && s.gitNew !== undefined) newP = s.gitNew;
  const creation = oldP === '/dev/null' || s.newFile;
  const deletion = newP === '/dev/null' || s.deletedFile;
  return (tree) => {
    if (creation) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.k === '+') plus.push(b.t);
      let text = '';
      if (plus.length > 0) {
        // A created file ends with a line break unless a `\` line follows its last `+` line.
        let noBreak = false;
        const all = s.hunks.flatMap((h) => h.body);
        for (let j = all.length - 1; j >= 0; j -= 1) {
          if (all[j]!.k === '+') {
            noBreak = all[j + 1]?.k === '\\';
            break;
          }
        }
        text = plus.join('\n') + (noBreak ? '' : '\n');
      }
      tree.now.set(p, text);
      return;
    }
    if (deletion) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP ?? '';
    const to = newP ?? from;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const after = applyHunks(before, s.hunks, strict, from);
    if (to !== from) {
      tree.now.set(from, null);
      tree.now.set(to, after);
      tree.noteMove(from, to);
    } else {
      tree.now.set(from, after);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | undefined;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        eq = j;
        break;
      }
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        const l = lines[j]!.trimEnd();
        if (l === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (l === '<<<<<<< SEARCH') break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | undefined;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchLine}`);
    const oldL = lines.slice(i + 1, eq);
    const newL = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldL, newL, strict));
    prevPath = path;
    i = rep + 1;
    searchFrom = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.length > 0 ? `${newL.join('\n')}\n` : '');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitText(before);
    const found = findTier(f.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLine[] = [
      ...oldL.map((t) => ({ k: '-', t, emptySrc: false })),
      ...newL.map((t) => ({ k: '+', t, emptySrc: false })),
    ];
    const out = buildOutput(body, f.lines, found.occ[0]!, found.tier);
    const lines = [...f.lines.slice(0, found.occ[0]!), ...out, ...f.lines.slice(found.occ[0]! + oldL.length)];
    tree.now.set(path, joinLines(lines, f.br, f.finalBreak));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  line: number;
  path: string;
  moveTo?: string;
  addLines: Array<{ t: string; emptySrc: boolean }>;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = lines.length - 1;
  while (lastNB >= 0 && blank(lines[lastNB]!)) lastNB -= 1;
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  const startChunk = (anchor: string | null): VChunk => {
    chunk = { anchor, eof: false, body: [] };
    cur!.chunks.push(chunk);
    return chunk;
  };

  for (let idx = firstNB + 1; idx < lastNB; idx += 1) {
    const line = lines[idx]!;
    const num = idx + 1;
    const isAdd = line.startsWith('*** Add File: ');
    const isDel = line.startsWith('*** Delete File: ');
    const isUpd = line.startsWith('*** Update File: ');
    if (isAdd || isDel || isUpd) {
      const path = line.slice(line.indexOf(': ') + 2).trim();
      cur = {
        kind: isAdd ? 'add' : isDel ? 'delete' : 'update',
        line: num,
        path,
        addLines: [],
        chunks: [],
      };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${num}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push({ t: line.slice(1), emptySrc: false });
      else if (line === '') cur.addLines.push({ t: '', emptySrc: true });
      else throw new Exit2(`error: parse ${num}`);
      continue;
    }
    if (cur.kind === 'delete') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${num}`);
    }
    // Update File section.
    if (line.startsWith('*** Move to: ') && cur.moveTo === undefined && cur.chunks.length === 0) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) startChunk(null);
      chunk!.eof = true;
      continue;
    }
    if (line.startsWith('@@')) {
      startChunk(line.slice(2).trim() === '' ? null : line.slice(2).trim());
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (chunk === null) startChunk(null);
      // A line that is empty or a single space is a blank line: at a section's end it is not part of it (section 8).
      chunk!.body.push({ k: line === '' ? ' ' : line[0]!, t: line === '' ? '' : line.slice(1), emptySrc: line === '' || line === ' ' });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  for (const s of sections) {
    if (s.kind === 'add') {
      while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1]!.emptySrc) s.addLines.pop();
    }
    if (s.kind === 'update') {
      const last = s.chunks[s.chunks.length - 1];
      if (last !== undefined) {
        while (last.body.length > 0 && last.body[last.body.length - 1]!.k === ' ' && last.body[last.body.length - 1]!.emptySrc) last.body.pop();
      }
      if (s.chunks.length === 0 && s.moveTo === undefined) throw new Exit2(`error: parse ${s.line}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const ls = s.addLines.map((l) => l.t);
      tree.now.set(s.path, ls.length > 0 ? `${ls.join('\n')}\n` : '');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitText(before);
    let lines = f.lines;
    let cursor = 0;
    const maxTier = strict ? 0 : 2;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (let tier = 0; tier <= maxTier && at < 0; tier += 1) {
          for (let p = cursor; p < lines.length; p += 1) {
            if (lineEq(lines[p]!, ch.anchor, tier)) {
              at = p;
              break;
            }
          }
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const O = oldLinesOf(ch.body);
      if (O.length === 0) {
        const plus = ch.body.filter((b) => b.k === '+').map((b) => b.t);
        const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines = [...lines.slice(0, pos), ...plus, ...lines.slice(pos)];
        cursor = pos + plus.length;
        continue;
      }
      let tierFound = -1;
      let occ: number[] = [];
      for (let tier = 0; tier <= maxTier; tier += 1) {
        occ = occurrences(lines, O, tier).filter((p) => p >= cursor && (!ch.eof || p + O.length === lines.length));
        if (occ.length > 0) {
          tierFound = tier;
          break;
        }
      }
      if (tierFound < 0) throw new Fail('no-match', s.path);
      const pos = occ[0]!;
      const out = buildOutput(ch.body, lines, pos, tierFound);
      lines = [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
      cursor = pos + newCountOf(ch.body);
    }
    const text = joinLines(lines, f.br, f.finalBreak);
    if (s.moveTo !== undefined) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.noteMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Invocation, output and the all-or-nothing write (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Change {
    was: string | null;
    now: string | null;
  }
  const changed = new Map<string, Change>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  interface Row {
    key: string;
    line: string;
    paths: string[];
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const [from, to] of tree.moves) {
    const cf = changed.get(from);
    const ct = changed.get(to);
    if (cf !== undefined && ct !== undefined && cf.was !== null && cf.now === null && ct.was === null && ct.now !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}`, paths: [from, to] });
      used.add(from);
      used.add(to);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const row of rows) {
      for (const p of row.paths) {
        const now = tree.now.get(p)!;
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
