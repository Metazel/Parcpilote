import { describe, expect, it } from 'vitest';
import { PROGRAMME_MAX_CHARS, type ProgrammePlace, isEmptyProgramme, parseProgramme } from '../src/data/programme';
import { DEFAULT_PROFILE } from '../src/state/storage';
import { AppStore } from '../src/state/store';
import { MemoryStorage, at } from './helpers';

const H = (h: number, m = 0) => h * 60 + m;

const PUY: ProgrammePlace[] = [
  { id: 'signe', name: 'Le Signe du Triomphe', kind: 'show' },
  { id: 'vikings', name: 'Les Vikings', kind: 'show' },
  { id: 'oiseaux', name: 'Le Bal des Oiseaux Fantômes', kind: 'show' },
  { id: 'ferme', name: 'La Ferme', kind: 'ride' },
  { id: 'zeus', name: 'Tonnerre de Zeus', kind: 'ride' },
  { id: 'goudurix', name: 'Goudurix', kind: 'ride' },
];

describe('reading a pasted programme', () => {
  it('reads opening hours, sessions on one line and sessions on the next lines', () => {
    const p = parseProgramme(
      ['PROGRAMME DU JOUR', 'Ouverture du parc : 9h30 - Fermeture 19h', 'Le Signe du Triomphe 11h30 - 15h00 - 17h45', 'LES VIKINGS', '12h15', '16:30', 'Durée 30 min'].join('\n'),
      PUY,
    );
    expect(p.hours).toEqual({ open: H(9, 30), close: H(19) });
    expect(p.shows).toEqual([
      { id: 'signe', name: 'Le Signe du Triomphe', times: [H(11, 30), H(15), H(17, 45)] },
      { id: 'vikings', name: 'Les Vikings', times: [H(12, 15), H(16, 30)] },
    ]);
    expect(p.newShows).toEqual([]);
  });

  it('reads hours given as separate lines or as a range', () => {
    expect(parseProgramme('Ouverture 10h\nFermeture 18h', PUY).hours).toEqual({ open: H(10), close: H(18) });
    expect(parseProgramme('Horaires : 10h – 22h30', PUY).hours).toEqual({ open: H(10), close: H(22, 30) });
    expect(parseProgramme('Parc 10:00 18:00', PUY).hours).toEqual({ open: H(10), close: H(18) });
    expect(parseProgramme('Ouverture 10h', PUY).hours).toBeNull();
    expect(parseProgramme('Horaires : 10h – 10h30', PUY).hours).toBeNull();
  });

  it('tolerates OCR slips in names and times', () => {
    const p = parseProgramme('Le Signe du Triomhpe 14h3O\nLES VIKlNGS l6h', PUY);
    expect(p.shows.find((s) => s.id === 'signe')?.times).toEqual([H(14, 30)]);
    expect(p.shows.find((s) => s.id === 'vikings')?.times).toEqual([H(16)]);
  });

  it('reads closures and waits for rides, and cancelled shows', () => {
    const p = parseProgramme(['Tonnerre de Zeus : 40 min', 'Goudurix FERMÉE', 'La Ferme 10 min', 'Les Vikings 14h annulé'].join('\n'), PUY);
    expect(p.waits).toEqual([
      { id: 'zeus', name: 'Tonnerre de Zeus', min: 40 },
      { id: 'ferme', name: 'La Ferme', min: 10 },
    ]);
    expect(p.closed).toEqual([{ id: 'goudurix', name: 'Goudurix' }]);
    expect(p.shows).toEqual([]);
  });

  it('offers unknown named sessions for adding, with a clean label', () => {
    const p = parseProgramme(['• Le Mime et l’Étoile : 12h, 16h', 'Les Noces de Feu', '22h30'].join('\n'), PUY);
    expect(p.newShows).toEqual([
      { name: 'Le Mime et l’Étoile', times: [H(12), H(16)] },
      { name: 'Les Noces de Feu', times: [H(22, 30)] },
    ]);
  });

  it('ignores impossible times, durations and words that look like times', () => {
    const p = parseProgramme(['Le Signe du Triomphe 25h70 1h30 9h', '19 hommes sur scène', 'Les Vikings durée 1h30', 'Billet 12 €'].join('\n'), PUY);
    expect(p.shows).toEqual([{ id: 'signe', name: 'Le Signe du Triomphe', times: [H(9)] }]);
    expect(p.newShows).toEqual([]);
  });

  it('caps the text, the sessions and the added shows', () => {
    const long = `Le Signe du Triomphe 11h\n${'x'.repeat(PROGRAMME_MAX_CHARS)}\nLes Vikings 12h`;
    const p = parseProgramme(long, PUY);
    expect(p.truncated).toBe(true);
    expect(p.shows.map((s) => s.id)).toEqual(['signe']);

    const many = Array.from({ length: 30 }, (_, i) => `${String(8 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
    expect(parseProgramme(`Les Vikings ${many.join(' ')}`, PUY).shows[0]?.times).toHaveLength(20);

    const shows = Array.from({ length: 50 }, (_, i) => `Spectacle numero ${i} 14h`).join('\n');
    expect(parseProgramme(shows, PUY).newShows).toHaveLength(30);
  });

  it('keeps markup and control characters out of labels', () => {
    const p = parseProgramme('<img src=x onerror=alert(1)> Grand Final\u202E 21h\u0000', PUY);
    expect(p.newShows).toHaveLength(1);
    const label = p.newShows[0]!.name;
    for (const c of ['<', '>', '=', '\u202E', '\u0000']) expect(label).not.toContain(c);
    expect(label.length).toBeLessThanOrEqual(80);
  });

  it('reads nothing from empty or meaningless text', () => {
    for (const t of ['', '   \n\n', '12345', '— • —', 'Bonne visite !']) expect(isEmptyProgramme(parseProgramme(t, PUY))).toBe(true);
    expect(isEmptyProgramme(parseProgramme('Les Vikings 14h', []))).toBe(false);
  });
});

describe('importing a programme into the day', () => {
  const make = () => {
    const store = new AppStore({ storage: new MemoryStorage(), fetchFn: null, realNow: () => at(10) });
    store.saveProfile({ ...DEFAULT_PROFILE, lunch: { ...DEFAULT_PROFILE.lunch, enabled: false } });
    return store;
  };

  it('applies the confirmed entries in manual mode, checking each value again', async () => {
    const store = make();
    await store.setDestination('puydufou');
    const show = store.addCustomPlace('Les Vikings', 'show', 30)!;
    const ride = store.addCustomPlace('Le Grand Carrousel', 'ride', 5)!;
    const n = store.importProgramme({
      hours: { open: H(9, 30), close: H(20) },
      shows: [
        { id: show, times: [H(12), H(16), H(16), 99999, -1] },
        { id: ride, times: [H(13)] },
        { id: 'inconnu', times: [H(13)] },
      ],
      newShows: [
        { name: '  Les   Noces de Feu ', times: [H(22, 30)] },
        { name: 'x', times: [H(11)] },
        { name: 'Sans horaire', times: [] },
      ],
      waits: [
        { id: ride, min: 25 },
        { id: show, min: 10 },
        { id: ride, min: 999 },
      ],
      closed: [],
    });
    expect(n).toBe(6);
    const s = store.getState();
    expect(s.snapshot?.showtimes[show]).toEqual([at(12), at(16)]);
    expect(s.snapshot?.attractions[ride]?.standby).toBe(25);
    expect(s.snapshot?.hours.puydufou?.close).toBe(at(20));
    const added = [...s.catalog.values()].find((p) => p.name === 'Les Noces de Feu');
    expect(added?.kind).toBe('show');
    expect(s.snapshot?.showtimes[added!.id]).toEqual([at(22, 30)]);

    expect(store.importProgramme({ hours: null, shows: [], newShows: [], waits: [], closed: [ride] })).toBe(1);
    expect(store.effectiveSnapshot()?.attractions[ride]?.status).toBe('DOWN');
    expect(store.importProgramme({ hours: { open: H(9), close: H(9, 30) }, shows: [], newShows: [], waits: [], closed: [] })).toBe(0);
  });

  it('does nothing on a park with live data', async () => {
    const store = make();
    await store.refresh();
    expect(store.importProgramme({ hours: { open: H(9), close: H(20) }, shows: [], newShows: [], waits: [], closed: [] })).toBeNull();
  });
});
