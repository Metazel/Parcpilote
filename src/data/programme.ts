import { normalizeName } from './catalog';

/**
 * Reads the day's information that the visitor pasted (typically the text their phone read
 * from a photo of a programme or a board: Live Text on iPhone, Google Lens on Android).
 * Nothing leaves the device and nothing is kept but the values the visitor confirms.
 *
 * The text is untrusted: it is size-capped, every value is range-checked, and the result
 * only holds catalogue ids, minutes and short plain-text labels (rendered as text by Preact).
 */

export const PROGRAMME_MAX_CHARS = 5000;
const MAX_LINES = 300;
const MAX_TIMES_PER_SHOW = 20;
const MAX_NEW_SHOWS = 30;
const LABEL_MIN = 2;
const LABEL_MAX = 80;
/** Times before 06:00 are durations ("1h30"), not sessions. */
const EARLIEST_MIN = 6 * 60;

export interface ProgrammePlace {
  readonly id: string;
  readonly name: string;
  readonly kind: 'ride' | 'show';
}

export interface ProgrammeShow {
  readonly id: string;
  readonly name: string;
  /** Minutes after midnight, sorted, unique. */
  readonly times: readonly number[];
}

export interface ProgrammeNewShow {
  readonly name: string;
  readonly times: readonly number[];
}

export interface Programme {
  /** Opening hours (minutes after midnight), when both ends were read. */
  readonly hours: { readonly open: number; readonly close: number } | null;
  readonly shows: readonly ProgrammeShow[];
  /** Named sessions that match nothing in the park's list (offered for adding). */
  readonly newShows: readonly ProgrammeNewShow[];
  readonly waits: ReadonlyArray<{ readonly id: string; readonly name: string; readonly min: number }>;
  readonly closed: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Text was cut to {@link PROGRAMME_MAX_CHARS}. */
  readonly truncated: boolean;
}

const STOP = new Set(['de', 'du', 'des', 'et', 'en', 'au', 'aux', 'un', 'une', 'and', 'of', 'a', 'd']);
const CLOSED_RE = /\b(fermee?s?|indisponibles?|maintenance|en panne|panne|interrompue?s?|hors service|closed|annulee?s?|cancelled|canceled|refurbishment|travaux)\b/;
const HOURS_RE = /\b(horaires?|ouverture|ouvert de|parc ouvert|fermeture|opening|park hours)\b/;
const PARK_RE = /\bparc\b/;
const OPEN_RE = /\b(ouverture|opening|ouvre)\b/;
const CLOSE_RE = /\b(fermeture|closing|ferme a)\b/;
const DURATION_RE = /\b(duree|duration|dure)\b/;
const TIME_RE = /(?<![\d:])([01]?\d|2[0-3])\s?(?:h|:)\s?([0-5]\d)?(?![\p{L}\d])/giu;
const WAIT_RE = /(?<!\d)(\d{1,3})\s?(?:min(?:utes?)?|mn|['’])(?![a-z])/i;

/** Common OCR slips inside time tokens: "14h3O" → "14h30", "l1h" → "11h". */
function fixOcrTimes(line: string): string {
  return line.replace(/(?<![A-Za-z\d])([\dOoIl]{1,2})(\s?[hH:]\s?)([\dOoIl]{2})?(?![A-Za-z\d])/g, (all, h: string, sep: string, m: string | undefined) => {
    if (!/\d/.test(h + (m ?? ''))) return all;
    const fix = (s: string) => s.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
    // Minutes made only of letters ("14h Il") are a word, not a slip.
    const mins = m === undefined ? '' : /\d/.test(m) ? fix(m) : m;
    return `${fix(h)}${sep}${mins}`;
  });
}

function extractTimes(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(TIME_RE)) {
    const t = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
    if (t >= EARLIEST_MIN && !out.includes(t)) out.push(t);
  }
  return out;
}

function stripTimes(line: string): string {
  return line.replace(TIME_RE, ' ');
}

/** A short plain label from a line: no times, no bullets, no control or markup characters. */
function cleanLabel(line: string): string {
  return stripTimes(line)
    .replace(WAIT_RE, ' ')
    .replace(/[^\p{L}\p{N}\s'’&!?.()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–.'’]+|[\s\-–.'’]+$/g, '')
    .slice(0, LABEL_MAX)
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Same word, or one OCR slip away (one letter added, dropped, changed or swapped). */
function closeEnough(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // Optimal string alignment distance (Levenshtein plus adjacent transpositions).
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!;
      const up = d[i - 1]!;
      row[j] = Math.min(up[j]! + 1, row[j - 1]! + 1, up[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]! <= 1;
}

interface Indexed {
  readonly place: ProgrammePlace;
  readonly toks: readonly string[];
}

/** Best catalogue place named in the line (all, or nearly all, of its words present). */
function bestMatch(lineToks: readonly string[], index: readonly Indexed[]): Indexed | null {
  if (lineToks.length === 0) return null;
  let best: { item: Indexed; score: number; size: number } | null = null;
  for (const item of index) {
    const { toks } = item;
    if (toks.length === 0) continue;
    let hit = 0;
    let weight = 0;
    for (const t of toks) {
      if (lineToks.includes(t)) {
        hit++;
        weight += 1;
      } else if (lineToks.some((l) => closeEnough(t, l))) {
        hit++;
        weight += 0.8;
      }
    }
    if (hit / toks.length < (toks.length <= 2 ? 1 : 0.75)) continue;
    // Exact words beat near misses: "Goudurix fermée" is Goudurix, not "La Ferme".
    const score = weight / toks.length;
    if (!best || score > best.score || (score === best.score && toks.length > best.size)) best = { item, score, size: toks.length };
  }
  return best?.item ?? null;
}

function hasLetters(s: string, min = 3): boolean {
  return (s.match(/\p{L}/gu)?.length ?? 0) >= min;
}

/** Parses the pasted text against the park's places. */
export function parseProgramme(raw: string, places: readonly ProgrammePlace[]): Programme {
  const truncated = raw.length > PROGRAMME_MAX_CHARS;
  // Control, zero-width and bidi characters are what we strip on purpose.
  // eslint-disable-next-line no-control-regex
  const text = raw.slice(0, PROGRAMME_MAX_CHARS).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, (c) => (c === '\u2028' || c === '\r' ? '\n' : ' '));
  const lines = text.split('\n').slice(0, MAX_LINES);
  const index: Indexed[] = places.map((place) => ({ place, toks: tokens(place.name) }));

  let open: number | null = null;
  let close: number | null = null;
  const shows = new Map<string, { name: string; times: Set<number> }>();
  const newShows = new Map<string, { name: string; times: Set<number> }>();
  const waits = new Map<string, { name: string; min: number }>();
  const closed = new Map<string, string>();
  const cancelled = new Set<string>();
  /** Where time-only lines go: the last named show (known or new). */
  let current: { kind: 'known' | 'new'; key: string } | null = null;
  let pendingLabel: string | null = null;

  const addTimes = (target: { times: Set<number> }, times: readonly number[]) => {
    for (const t of times) if (target.times.size < MAX_TIMES_PER_SHOW) target.times.add(t);
  };
  const newShow = (label: string): string | null => {
    const key = normalizeName(label);
    if (!key || label.length < LABEL_MIN || !hasLetters(label)) return null;
    if (!newShows.has(key)) {
      if (newShows.size >= MAX_NEW_SHOWS) return null;
      newShows.set(key, { name: label, times: new Set() });
    }
    return key;
  };

  for (const rawLine of lines) {
    const line = fixOcrTimes(rawLine).trim();
    if (!line) continue;
    const norm = normalizeName(line);
    const times = extractTimes(line);
    const rest = stripTimes(line);
    const restNorm = normalizeName(rest);
    const isDuration = DURATION_RE.test(norm);
    const restToks = tokens(rest);
    const found = bestMatch(restToks, index);
    const match = found?.place ?? null;
    // Status words are read outside the place's own name ("La Ferme" is not "fermée").
    const status = found ? restToks.filter((t) => !found.toks.some((p) => closeEnough(p, t))).join(' ') : restNorm;

    if (!match && times.length > 0 && (HOURS_RE.test(restNorm) || (PARK_RE.test(restNorm) && times.length >= 2))) {
      if (times.length >= 2) {
        open = times[0]!;
        close = times[times.length - 1]!;
      } else if (CLOSE_RE.test(restNorm)) close = times[0]!;
      else if (OPEN_RE.test(restNorm)) open = times[0]!;
      current = null;
      pendingLabel = null;
      continue;
    }

    if (match?.kind === 'show') {
      pendingLabel = null;
      if (CLOSED_RE.test(status)) {
        cancelled.add(match.id);
        current = null;
        continue;
      }
      let entry = shows.get(match.id);
      if (!entry) shows.set(match.id, (entry = { name: match.name, times: new Set() }));
      if (!isDuration) addTimes(entry, times);
      current = { kind: 'known', key: match.id };
      continue;
    }

    if (match?.kind === 'ride') {
      pendingLabel = null;
      current = null;
      if (CLOSED_RE.test(status)) {
        closed.set(match.id, match.name);
        waits.delete(match.id);
        continue;
      }
      const w = isDuration ? null : WAIT_RE.exec(rest);
      const min = w ? Number(w[1]) : NaN;
      if (Number.isInteger(min) && min >= 0 && min <= 300 && !closed.has(match.id)) waits.set(match.id, { name: match.name, min });
      continue;
    }

    // Nothing known on this line.
    const label = cleanLabel(line);
    if (times.length > 0 && !isDuration) {
      if (hasLetters(label)) {
        const key = newShow(label);
        if (key) {
          addTimes(newShows.get(key)!, times);
          current = { kind: 'new', key };
        }
      } else if (current) {
        const target = current.kind === 'known' ? shows.get(current.key) : newShows.get(current.key);
        if (target) addTimes(target, times);
      } else if (pendingLabel) {
        const key = newShow(pendingLabel);
        if (key) {
          addTimes(newShows.get(key)!, times);
          current = { kind: 'new', key };
        }
      }
      pendingLabel = null;
    } else if (hasLetters(label)) {
      pendingLabel = label;
      current = null;
    }
  }

  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return {
    hours: open !== null && close !== null && close > open + 60 ? { open, close } : null,
    shows: [...shows.entries()].filter(([id, s]) => s.times.size > 0 && !cancelled.has(id)).map(([id, s]) => ({ id, name: s.name, times: sorted(s.times) })),
    newShows: [...newShows.values()].filter((s) => s.times.size > 0).map((s) => ({ name: s.name, times: sorted(s.times) })),
    waits: [...waits.entries()].map(([id, w]) => ({ id, name: w.name, min: w.min })),
    closed: [...closed.entries()].map(([id, name]) => ({ id, name })),
    truncated,
  };
}

/** Nothing usable was read. */
export function isEmptyProgramme(p: Programme): boolean {
  return !p.hours && p.shows.length === 0 && p.newShows.length === 0 && p.waits.length === 0 && p.closed.length === 0;
}
