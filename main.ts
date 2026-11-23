// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
}

type Edit = (tree: Tree) => void;

/** Move edits (sections 6 and 8) that succeeded in the current run, as [old, new] pairs, for the R lines of section 2. */
let MOVES: [string, string][] = [];

/** A file as lines (section 3): its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const parts = text.split(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

/** One body line of a unified hunk or a V4A chunk: a context, old, new or no-newline line, and its text. */
interface Item {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** The patch line was empty (a unified body trims those at its end). */
  emptyLine?: boolean;
}

// Section 5: matching lines at three tiers.

const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Every position at or after `from` where O occurs at `tier`; when `endAt` is set, only ones ending at that line count. */
function occurrences(lines: string[], O: string[], tier: number, from: number, endAt: number | null): number[] {
  const out: number[] = [];
  const want = O.map((l) => normLine(l, tier));
  outer: for (let i = from; i + O.length <= lines.length; i++) {
    if (endAt !== null && i + O.length !== endAt) continue;
    for (let j = 0; j < O.length; j++) if (normLine(lines[i + j]!, tier) !== want[j]) continue outer;
    out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with every occurrence there, or null. */
function matchTier(lines: string[], O: string[], strict: boolean, from: number, endAt: number | null): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const ps = occurrences(lines, O, tier, from, endAt);
    if (ps.length > 0) return { tier, positions: ps };
  }
  return null;
}

/** Section 5's tier-2 re-indent of one new line: its patch indent P becomes the file's F. */
function reindent(l: string, F: string, P: string): string {
  return l.trim() !== '' && l.startsWith(P) ? F + l.slice(P.length) : l;
}

/**
 * The lines a matched hunk, chunk or block writes: context lines are the file's own matched lines, `-` lines
 * vanish, `+` lines are the patch's, re-indented at tier 2.
 */
function buildNew(items: Item[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const F = leadWS(fileLines[pos] ?? '');
  const P = leadWS(O[0] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === ' ') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (it.kind === '-') {
      oi++;
    } else if (it.kind === '+') {
      out.push(tier === 2 ? reindent(it.text, F, P) : it.text);
    }
  }
  return out;
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

// Section 6: unified diffs.

interface UHunk {
  a: number;
  items: Item[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** A `---`/`+++` path: up to the first tab, spaces removed, then a leading a/ or b/ removed. */
function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Apply a section's hunks in order to a file's lines; d is the running line drift of the section's earlier hunks. */
function applyHunks(fl: FileLines, hunks: UHunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    let nLen = 0;
    for (const it of h.items) {
      if (it.kind === ' ' || it.kind === '-') O.push(it.text);
      if (it.kind === ' ' || it.kind === '+') nLen++;
    }
    let lastCP = -1;
    h.items.forEach((it, j) => {
      if (it.kind === ' ' || it.kind === '+') lastCP = j;
    });
    const bsAfter = lastCP >= 0 && h.items[lastCP + 1]?.kind === '\\';
    if (O.length === 0) {
      const adds = h.items.filter((it) => it.kind === '+').map((it) => it.text);
      const pos = Math.max(0, Math.min(h.a + d, fl.lines.length));
      const atEnd = pos === fl.lines.length;
      fl.lines.splice(pos, 0, ...adds);
      if (atEnd) fl.finalBr = !bsAfter;
      d += adds.length;
    } else {
      const m = matchTier(fl.lines, O, strict, 0, null);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      for (const p of m.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const repl = buildNew(h.items, fl.lines, pos, m.tier, O);
      const runsToEnd = pos + O.length === fl.lines.length;
      fl.lines.splice(pos, O.length, ...repl);
      if (runsToEnd) fl.finalBr = !bsAfter;
      d += nLen - O.length;
    }
  }
}

/** One unified section as an edit: a creation, a deletion, a move or a change, per its header. */
function sectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameOld ?? sec.gitOld;
    const newP = sec.pairNew ?? sec.renameNew ?? sec.gitNew;
    if (sec.newFile || oldP === '/dev/null') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let finalBr = true;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        h.items.forEach((it, j) => {
          if (it.kind === '+') lastPlus = j;
        });
        if (lastPlus >= 0) finalBr = h.items[lastPlus + 1]?.kind !== '\\';
        for (const it of h.items) if (it.kind === '+') out.push(it.text);
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (sec.delFile || newP === '/dev/null') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (n !== o && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const fl = splitFile(before);
    applyHunks(fl, sec.hunks, o, strict);
    const text = joinFile(fl);
    if (n !== o) {
      tree.now.set(o, null);
      tree.now.set(n, text);
      MOVES.push([o, n]);
    } else {
      tree.now.set(o, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: UHunk | null = null;
  const newSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameOld: null, renameNew: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const endHunk = (): void => {
    if (hunk !== null) {
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.emptyLine) hunk.items.pop();
      hunk = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (hunk !== null) {
      if (L.startsWith('diff --git ') || (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endHunk();
      } else if (L === '' || L[0] === ' ' || L[0] === '-' || L[0] === '+' || L[0] === '\\') {
        hunk.items.push(L === '' ? { kind: ' ', text: '', emptyLine: true } : { kind: L[0] as Item['kind'], text: L.slice(1) });
        i++;
        continue;
      } else {
        endHunk();
      }
    }
    if (L.startsWith('diff --git ') || L === 'diff --git') {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), items: [] };
      cur.hunks.push(hunk);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (L.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(L.slice(4));
          cur.pairNew = headerPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (L.startsWith('+++ ')) {
        cur.pairNew = headerPath(L.slice(4));
        i++;
        continue;
      }
      if (L.startsWith('rename from ')) {
        cur.renameOld = L.slice(12).trim();
        i++;
        continue;
      }
      if (L.startsWith('rename to ')) {
        cur.renameNew = L.slice(10).trim();
        i++;
        continue;
      }
      if (L.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (L.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      cur.pairOld = headerPath(L.slice(4));
      cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    i++;
  }
  endHunk();
  return sections.map((s) => sectionEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = splitFile(before);
    const m = matchTier(fl.lines, oldLines, strict, 0, null);
    if (m === null) throw new Fail('no-match', path);
    if (m.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = m.positions[0]!;
    const repl = buildNew(
      newLines.map((t) => ({ kind: '+' as const, text: t })),
      fl.lines,
      pos,
      m.tier,
      oldLines,
    );
    fl.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(fl));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = at + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(srEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headerLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const n = sec.moveTo;
    if (n !== null && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (n !== null && tree.get(n) !== null) throw new Fail('exists', n);
    const fl = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const am = matchTier(fl.lines, [ch.anchor], strict, cursor, null);
        if (am === null) throw new Fail('no-match', p);
        cursor = am.positions[0]! + 1;
      }
      const O: string[] = [];
      for (const it of ch.items) if (it.kind === ' ' || it.kind === '-') O.push(it.text);
      if (O.length === 0) {
        const adds = ch.items.filter((it) => it.kind === '+').map((it) => it.text);
        const pos = ch.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
      } else {
        const m = matchTier(fl.lines, O, strict, cursor, ch.eof ? fl.lines.length : null);
        if (m === null) throw new Fail('no-match', p);
        const pos = m.positions[0]!;
        const repl = buildNew(ch.items, fl.lines, pos, m.tier, O);
        fl.lines.splice(pos, O.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const text = joinFile(fl);
    if (n !== null) {
      tree.now.set(p, null);
      tree.now.set(n, text);
      MOVES.push([p, n]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (L: string): { kind: VSection['kind']; path: string } | null => {
    if (L.startsWith('*** Add File: ')) return { kind: 'add', path: L.slice(14).trim() };
    if (L.startsWith('*** Delete File: ')) return { kind: 'del', path: L.slice(17).trim() };
    if (L.startsWith('*** Update File: ')) return { kind: 'upd', path: L.slice(17).trim() };
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i++;
      continue;
    }
    const st = secStart(L);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { ...st, headerLine: i + 1, moveTo: null, addLines: [], chunks: [] };
    sections.push(sec);
    i++;
    const raw: { line: string; num: number }[] = [];
    while (i < last && secStart(lines[i]!) === null) {
      raw.push({ line: lines[i]!, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (sec.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    } else if (sec.kind === 'add') {
      for (const e of raw) {
        if (e.line.startsWith('+')) sec.addLines.push(e.line.slice(1));
        else if (e.line === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${e.num}`);
      }
    } else {
      let chunk: VChunk | null = null;
      raw.forEach((e, idx) => {
        const line = e.line;
        if (line.startsWith('*** Move to: ')) {
          if (idx !== 0) throw new Exit2(`error: parse ${e.num}`);
          sec.moveTo = line.slice(13).trim();
          return;
        }
        if (line.trimEnd() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${e.num}`);
          chunk.eof = true;
          chunk = null;
          return;
        }
        if (line.startsWith('@@')) {
          const anchor = line.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          sec.chunks.push(chunk);
          return;
        }
        if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${e.num}`);
            chunk = { anchor: null, eof: false, items: [] };
            sec.chunks.push(chunk);
          }
          chunk.items.push(line === '' ? { kind: ' ', text: '' } : { kind: line[0] as Item['kind'], text: line.slice(1) });
          return;
        }
        throw new Exit2(`error: parse ${e.num}`);
      });
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.headerLine}`);
    }
  }
  return sections.map((s) => v4aEdit(s, strict));
}

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
  MOVES = [];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const consumed = new Set<string>();
  const rows: [string, string][] = [];
  for (const [o, n] of MOVES) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      consumed.add(o);
      consumed.add(n);
      rows.push([n, `R ${o} -> ${n}`]);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r[1]), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
