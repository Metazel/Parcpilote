"""End-to-end acceptance tests for ParcPilote (Playwright, Chromium headless).

Serves dist/ with a small built-in static server (no Node needed, so it runs in the Playwright
CI image), then runs the user-story scenarios on a phone viewport.
Usage: npm run build && npm run build:single && python3 e2e/run_e2e.py [--shots DIR]
Requires: pip install -r e2e/requirements.txt && python -m playwright install chromium.
axe-core is read from node_modules or $AXE_PATH.
"""

from __future__ import annotations

import functools
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = "http://127.0.0.1:4173/"
PARIS = timezone(timedelta(hours=2))  # CEST on 22 Oct 2026
DAY_10H = datetime(2026, 10, 22, 10, 0, tzinfo=PARIS)
PHONE = {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True, "locale": "fr-FR", "timezone_id": "Europe/Paris"}
SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None

results: list[tuple[str, bool, str]] = []


def scenario(name: str):
    def wrap(fn):
        def run(*args, **kwargs):
            t0 = time.perf_counter()
            try:
                fn(*args, **kwargs)
                results.append((name, True, f"{(time.perf_counter() - t0):.1f}s"))
            except Exception as exc:  # noqa: BLE001 - report every failure
                results.append((name, False, f"{type(exc).__name__}: {exc}".splitlines()[0][:300]))
                # Neutralise "::" so no error text can be read as a GitHub workflow command.
                print(traceback.format_exc().replace("::", ": :"), file=sys.stderr, flush=True)
        return run
    return wrap


def shot(page: Page, name: str) -> None:
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def new_page(browser: Browser, *, live_mock: bool = False, osm: bool = True, tiles: bool = True, **extra) -> tuple[BrowserContext, Page, list[str]]:
    ctx = browser.new_context(**{**PHONE, **extra})
    errors: list[str] = []
    if live_mock:
        ctx.route("https://api.themeparks.wiki/**", lambda route: route.fulfill(**mock_api(route.request.url)))
    else:
        ctx.route("https://api.themeparks.wiki/**", lambda route: route.abort("internetdisconnected"))
    if osm:
        ctx.route("https://overpass-api.de/**", lambda route: route.fulfill(status=200, body=OVERPASS, content_type="application/json", headers={"access-control-allow-origin": "*"}))
    else:
        ctx.route("https://overpass-api.de/**", lambda route: route.abort("internetdisconnected"))
    if tiles:
        ctx.route("https://tile.openstreetmap.org/**", lambda route: route.fulfill(status=200, body=TILE, content_type="image/png"))
    else:
        ctx.route("https://tile.openstreetmap.org/**", lambda route: route.abort("internetdisconnected"))
    page = ctx.new_page()
    page.clock.set_fixed_time(DAY_10H)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" and "themeparks.wiki" not in m.text and "ERR_INTERNET_DISCONNECTED" not in m.text and "openstreetmap" not in m.text else None)
    page.on("dialog", lambda d: (errors.append(f"unexpected dialog: {d.message}"), d.dismiss()))
    return ctx, page, errors


def overpass_grid() -> dict:
    """Same synthetic footway grid as tests/fixtures.ts, plus service points."""
    elements: list[dict] = []
    lats = [round(48.862 + i * 0.0005, 6) for i in range(33)]
    lons = [round(2.769 + j * 0.0007, 6) for j in range(23)]
    nid = lambda r, c: 1_000_000 + r * 1000 + c  # noqa: E731
    for r, la in enumerate(lats):
        tags = {"highway": "footway", **({"name": "Allée centrale"} if r == 20 else {})}
        elements.append({"type": "way", "id": 10 + r, "tags": tags, "nodes": [nid(r, c) for c in range(len(lons))], "geometry": [{"lat": la, "lon": lo} for lo in lons]})
    for c, lo in enumerate(lons):
        tags = {"highway": "path" if c % 2 else "pedestrian", **({"name": "Promenade Est"} if c == 10 else {})}
        elements.append({"type": "way", "id": 500 + c, "tags": tags, "nodes": [nid(r, c) for r in range(len(lats))], "geometry": [{"lat": la, "lon": lo} for la in lats]})
    elements += [
        {"type": "node", "id": 1, "lat": 48.8735, "lon": 2.776, "tags": {"amenity": "toilets"}},
        {"type": "node", "id": 2, "lat": 48.8668, "lon": 2.778, "tags": {"amenity": "toilets", "name": "Toilettes Worlds of Pixar"}},
        {"type": "node", "id": 3, "lat": 48.8745, "lon": 2.7755, "tags": {"amenity": "fast_food", "name": "<img src=x onerror=alert(1)>"}},
        {"type": "node", "id": 4, "lat": 48.8712, "lon": 2.7738, "tags": {"amenity": "drinking_water"}},
    ]
    return {"elements": elements}


def tile_png() -> bytes:
    import io

    from PIL import Image, ImageDraw

    img = Image.new("RGB", (256, 256), (232, 236, 228))
    d = ImageDraw.Draw(img)
    for k in range(0, 256, 32):
        d.line([(k, 0), (k, 256)], fill=(210, 214, 206))
        d.line([(0, k), (256, k)], fill=(210, 214, 206))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


TILE = tile_png()
OVERPASS = json.dumps(overpass_grid())


def mock_api(url: str) -> dict:
    path = url.split("/v1", 1)[1]
    iso = lambda h, m=0: f"2026-10-22T{h:02d}:{m:02d}:00+02:00"  # noqa: E731
    routes = {
        "/destinations": {"destinations": [{"id": "dlpr", "name": "Disneyland Paris", "slug": "disneylandparis", "parks": [{"id": "p-dlp", "name": "Disneyland Park"}, {"id": "p-daw", "name": "Disney Adventure World"}]}]},
        "/entity/p-dlp/children": {"children": [
            {"id": "pp", "name": "Peter Pan's Flight", "entityType": "ATTRACTION"},
            {"id": "btm", "name": "Big Thunder Mountain", "entityType": "ATTRACTION"},
            {"id": "new1", "name": "<img src=x onerror=alert(1)>", "entityType": "ATTRACTION"},
        ]},
        "/entity/p-dlp/live": {"liveData": [
            {"id": "pp", "name": "Peter Pan's Flight", "entityType": "ATTRACTION", "status": "OPERATING", "queue": {"STANDBY": {"waitTime": 55}}},
            {"id": "btm", "name": "Big Thunder Mountain", "entityType": "ATTRACTION", "status": "DOWN", "queue": {"STANDBY": {"waitTime": None}}},
            {"id": "new1", "name": "<img src=x onerror=alert(1)>", "entityType": "ATTRACTION", "status": "OPERATING", "queue": {"STANDBY": {"waitTime": 5}}},
        ]},
        "/entity/p-dlp/schedule": {"schedule": [{"date": "2026-10-22", "type": "OPERATING", "openingTime": iso(9, 30), "closingTime": iso(22)}]},
        "/entity/p-daw/children": {"children": [{"id": "crush", "name": "Crush's Coaster", "entityType": "ATTRACTION"}]},
        "/entity/p-daw/live": {"liveData": [{"id": "crush", "name": "Crush's Coaster", "entityType": "ATTRACTION", "status": "OPERATING", "queue": {"STANDBY": {"waitTime": 75}}}]},
        "/entity/p-daw/schedule": {"schedule": []},
    }
    body = routes.get(path)
    if body is None:
        return {"status": 404, "body": "{}", "headers": {"access-control-allow-origin": "*"}}
    return {"status": 200, "body": json.dumps(body), "content_type": "application/json", "headers": {"access-control-allow-origin": "*"}}


def onboard(page: Page, *, child_cm: int | None = 110, budget: int = 20) -> None:
    page.goto(URL)
    expect(page.get_by_role("heading", name="Votre groupe")).to_be_visible()
    page.get_by_label("Nombre de personnes").fill("3")
    if child_cm is not None:
        page.get_by_label("Il y a un enfant dans le groupe").check()
        page.get_by_label("Taille du plus petit (cm)").fill(str(child_cm))
    page.get_by_label("Budget Premier Access par personne (€)").fill(str(budget))
    page.get_by_role("button", name="Commencer la visite").click()
    expect(page.get_by_role("heading", name="Ma liste")).to_be_visible()


def set_priority(page: Page, ride: str, label: str) -> None:
    page.get_by_role("radiogroup", name=f"Priorité pour {ride}").get_by_role("radio", name=label, exact=True).check()


def tab(page: Page, name: str) -> None:
    page.get_by_role("navigation", name="Navigation principale").get_by_role("button", name=name).click()


def sign_title(page: Page) -> str:
    return page.locator("#next-title").inner_text().strip()


def run(browser: Browser) -> None:
    ctx, page, errors = new_page(browser)

    @scenario("US1 Profil : taille de l'enfant exclut les attractions interdites")
    def s1():
        onboard(page)
        shot(page, "01-liste")
        indiana = page.get_by_role("group", name="Indiana Jones and the Temple of Peril")
        expect(indiana.get_by_text("Réservée aux personnes d'au moins 140 cm")).to_be_visible()
        expect(indiana.get_by_role("radio")).to_have_count(0)

    @scenario("Ma liste : priorités et séance de spectacle")
    def s2():
        for ride in ["Peter Pan's Flight", "Big Thunder Mountain", "Buzz Lightyear Laser Blast", "Crush's Coaster"]:
            set_priority(page, ride, "Incontournable")
        for ride in ["Dumbo the Flying Elephant", '"it\'s a small world"']:
            set_priority(page, ride, "Si possible")
        expect(page.get_by_text("6 attractions choisies, dont 4 incontournables.")).to_be_visible()
        group = page.get_by_role("radiogroup", name="Séance de Célébration à Arendelle")
        group.get_by_role("radio", name="14:00").check()
        expect(group.get_by_role("radio", name="14:00")).to_be_checked()

    state: dict[str, str] = {}

    @scenario("US2 Maintenant : prochaine étape lisible en un écran")
    def s3():
        tab(page, "Maintenant")
        title = sign_title(page)
        assert title, "titre vide"
        state["first"] = title
        facts = page.locator(".facts").inner_text()
        assert re.search(r"\d+ min", facts) and re.search(r"\d{2}:\d{2}", facts), facts
        box = page.locator(".sign").bounding_box()
        assert box and box["y"] + box["height"] <= 844, f"panneau hors écran: {box}"
        shot(page, "02-maintenant")

    @scenario("Étape terminée : position et plan mis à jour")
    def s4():
        page.get_by_role("button", name=re.compile("Attraction faite|Spectacle vu|Pause terminée")).click()
        expect(page.locator("#next-title")).not_to_have_text(state["first"])
        expect(page.locator(".summary")).to_contain_text("Faits aujourd'hui : 1")

    @scenario("US5 Plan : arrivée au spectacle avant l'heure, marge comprise")
    def s5():
        tab(page, "Plan")
        stop = page.locator(".stop.show", has_text="Célébration à Arendelle")
        expect(stop).to_be_visible()
        meta = stop.locator(".stop-meta").inner_text()
        m = re.search(r"Arrivée (\d{2}):(\d{2}), début (\d{2}):(\d{2})", meta)
        assert m, meta
        arrive = int(m[1]) * 60 + int(m[2])
        start = int(m[3]) * 60 + int(m[4])
        assert start == 14 * 60, meta
        assert start - arrive >= 10, f"marge insuffisante: {meta}"
        shot(page, "03-plan")

    @scenario("US3 Panne : replanification < 10 s et alerte")
    def s6():
        tab(page, "Maintenant")
        before = sign_title(page)
        tab(page, "Groupe")
        btn = page.get_by_role("button", name=re.compile("^Simuler une panne de "))
        target = btn.inner_text().replace("Simuler une panne de ", "")
        t0 = time.perf_counter()
        btn.click()
        tab(page, "Maintenant")
        expect(page.get_by_role("region", name="Alertes")).to_contain_text(f"{target} est en panne")
        assert time.perf_counter() - t0 < 10
        if target == before:
            expect(page.locator("#next-title")).not_to_have_text(before)
        tab(page, "Plan")
        expect(page.locator("ul.reasons li", has_text=target)).to_contain_text("Fermée ou en panne")
        shot(page, "04-panne")

    @scenario("US8 Signalement : attente réelle en deux gestes, saisie validée")
    def s7():
        tab(page, "Maintenant")
        page.locator(".sign").get_by_role("button", name="Signaler").click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        dialog.get_by_label("J'ai réellement attendu (minutes)").fill("-4")
        dialog.get_by_role("button", name="Envoyer l'attente").click()
        expect(dialog.get_by_role("status")).to_contain_text("entre 0 et 300")
        dialog.get_by_label("J'ai réellement attendu (minutes)").fill("5")
        dialog.get_by_role("button", name="Envoyer l'attente").click()
        expect(dialog.get_by_role("status")).to_contain_text("Merci")
        shot(page, "05-signalement")
        dialog.get_by_role("button", name="Fermer").click()
        expect(dialog).to_be_hidden()

    @scenario("US6 Premier Access : conseil chiffré puis créneau intégré au plan")
    def s8():
        tab(page, "Groupe")
        page.get_by_label("Aller à l'heure").fill("13:00")
        page.get_by_role("button", name="Aller à cette heure").click()
        tab(page, "Maintenant")
        panel = page.locator("section.panel", has_text="Premier Access conseillé")
        expect(panel).to_be_visible()
        name = panel.locator("h3").inner_text().replace("Premier Access conseillé : ", "")
        assert re.search(r"\d+ min gagnées", panel.inner_text())
        shot(page, "06-premier-access")
        panel.get_by_role("button", name="J'ai acheté").click()
        panel.get_by_role("button", name="Enregistrer le créneau").click()
        tab(page, "Plan")
        expect(page.locator(".stop.pa", has_text=name)).to_be_visible()

    @scenario("Persistance : l'état survit au rechargement")
    def s9():
        page.reload()
        expect(page.get_by_role("navigation", name="Navigation principale")).to_be_visible()
        tab(page, "Plan")
        expect(page.get_by_role("heading", name="Déjà fait ou retiré")).to_be_visible()

    @scenario("US7 Hors-ligne : l'application se recharge sans réseau")
    def s10():
        page.evaluate("async () => { await navigator.serviceWorker.ready; }")
        if not page.evaluate("navigator.serviceWorker.controller !== null"):
            page.reload()
            page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=15000)
        ctx.set_offline(True)
        page.reload()
        expect(page.get_by_role("navigation", name="Navigation principale")).to_be_visible()
        tab(page, "Plan")
        expect(page.get_by_role("heading", name="Plan du jour")).to_be_visible()
        ctx.set_offline(False)

    @scenario("Carte : fond OSM, marqueurs, circuit numéroté et explications par tronçon")
    def s11():
        tab(page, "Carte")
        expect(page.locator(".leaflet-container")).to_be_visible()
        expect(page.locator("img.leaflet-tile-loaded").first).to_be_visible()
        assert page.evaluate("getComputedStyle(document.querySelector('img.leaflet-tile-loaded')).opacity") == "1", "tuiles invisibles"
        assert page.locator("path.mk-ride").count() >= 30
        expect(page.locator("path.mk-toilets")).to_have_count(2)
        expect(page.locator("path.route-next")).to_have_count(1)
        legs = page.locator("ol.legs li")
        assert legs.count() >= 3, legs.count()
        expect(page.locator(".stop-badge")).to_have_count(legs.count())
        assert re.search(r"\d+ min, \d+ m", legs.first.inner_text()), legs.first.inner_text()
        expect(page.locator("ol.legs")).to_contain_text("par ")
        expect(page.get_by_text("Trajets calculés sur les allées OpenStreetMap.")).to_be_visible()
        legs.nth(1).get_by_role("button", name=re.compile("^Voir le trajet vers")).click()
        shot(page, "07-carte")

    for fn in (s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11):
        fn()
    console_errors = [e for e in errors if "Failed to load resource" not in e]
    results.append(("Aucune erreur JavaScript ni dialogue inattendu (parcours principal)", not console_errors, "; ".join(console_errors)[:300] or "ok"))
    ctx.close()


def run_security(browser: Browser) -> None:
    ctx, page, errors = new_page(browser)

    @scenario("Sécurité : stockage local hostile ignoré, aucun script exécuté")
    def sec():
        page.goto(URL)
        hostile = {
            "version": 1,
            "profile": {"size": 3, "smallestHeightCm": None, "singleRiderOk": True, "paBudgetEur": 10, "pace": "fast", "stroller": False, "lunch": {"enabled": False, "atMin": 750, "durationMin": 45}, "startPark": "dlp", "__proto__": {"admin": True}},
            "wishes": [["<img src=x onerror=alert(1)>", "must"], ["dlp-buzz", "must"], ["javascript:alert(1)", "nice"]],
            "day": {"dateKey": "2026-10-22", "done": ["<script>alert(1)</script>"], "shows": [{"showId": "x\"><svg onload=alert(1)>", "start": 1}]},
            "settings": {"source": "demo", "demoClock": {"base": "evil", "realBase": 0, "speed": 1000}},
        }
        page.evaluate("s => localStorage.setItem('parcpilote:v1', s)", json.dumps(hostile))
        page.reload()
        expect(page.get_by_role("navigation", name="Navigation principale")).to_be_visible()
        stored = page.evaluate("JSON.parse(localStorage.getItem('parcpilote:v1'))")
        assert stored["wishes"] == [["dlp-buzz", "must"]], stored["wishes"]
        assert page.evaluate("({}).admin") is None
        assert page.locator("img[src='x']").count() == 0
        assert not [e for e in errors if "dialog" in e], errors

    @scenario("Sécurité : CSP stricte présente (script-src 'self', pas d'inline)")
    def csp():
        content = page.locator("meta[http-equiv='Content-Security-Policy']").get_attribute("content") or ""
        assert "script-src 'self'" in content and "unsafe-inline" not in content and "connect-src 'self' https://api.themeparks.wiki" in content, content
        blocked = page.evaluate(
            """() => new Promise((resolve) => {
                document.addEventListener('securitypolicyviolation', () => resolve(true), { once: true });
                const s = document.createElement('script'); s.textContent = 'window.__pwned = 1'; document.body.appendChild(s);
                setTimeout(() => resolve(window.__pwned !== 1), 500);
            })"""
        )
        assert blocked, "un script inline a pu s'exécuter"

    sec()
    csp()
    ctx.close()


def run_live(browser: Browser) -> None:
    ctx, page, errors = new_page(browser, live_mock=True)

    @scenario("Direct : données ThemeParks.wiki affichées, noms hostiles échappés")
    def live():
        onboard(page, child_cm=None, budget=0)
        expect(page.locator(".status")).to_contain_text("En direct")
        peter = page.get_by_role("group", name="Peter Pan's Flight")
        expect(peter.locator(".item-meta")).to_contain_text("55 min")
        expect(page.get_by_role("group", name="Big Thunder Mountain").locator(".item-meta")).to_contain_text("En panne")
        expect(page.get_by_role("group", name="<img src=x onerror=alert(1)>")).to_be_visible()
        assert page.locator("img[src='x']").count() == 0
        assert not [e for e in errors if "dialog" in e], errors
        shot(page, "08-direct")

    live()
    ctx.close()

    ctx, page, errors = new_page(browser, live_mock=True)

    @scenario("Soir, parcs fermés : préparer la visite sur une journée simulée")
    def evening():
        page.clock.set_fixed_time(datetime(2026, 10, 22, 23, 15, tzinfo=PARIS))
        onboard(page, child_cm=None, budget=0)
        set_priority(page, "Peter Pan's Flight", "Incontournable")
        tab(page, "Maintenant")
        expect(page.get_by_role("heading", name="Les parcs sont fermés")).to_be_visible()
        page.get_by_role("button", name="Préparer sur une journée simulée").click()
        expect(page.locator(".status")).to_contain_text("Démo")
        expect(page.locator("#next-title")).to_have_text("Peter Pan's Flight")

    evening()
    ctx.close()


def run_map(browser: Browser) -> None:
    ctx, page, errors = new_page(browser, permissions=["geolocation"], geolocation={"latitude": 48.8741, "longitude": 2.7757, "accuracy": 15})

    @scenario("Géolocalisation : position réelle, toilettes à proximité, itinéraire tracé")
    def geo():
        onboard(page, child_cm=None, budget=0)
        tab(page, "Carte")
        page.get_by_role("button", name="Me localiser").click()
        expect(page.get_by_text(re.compile("Position du téléphone, précision 15 m"))).to_be_visible()
        expect(page.locator(".map-canvas")).to_have_attribute("data-view", re.compile(r"^1[7-9](\.5)?\|48\.874"))
        expect(page.locator("path.me-dot:not(.me-estimated)")).to_have_count(1)
        first = page.locator("ul.nearby li").first
        expect(first).to_contain_text("Toilettes")
        assert re.search(r"\d+ min à pied", first.inner_text()), first.inner_text()
        first.get_by_role("button", name=re.compile("^Itinéraire vers")).click()
        expect(page.locator("path.route-focus")).to_have_count(1)
        expect(page.locator("#sel-title")).to_have_text("Toilettes")
        expect(page.locator("section.panel")).to_contain_text("À pied depuis votre position")
        page.get_by_role("radiogroup", name="Type de lieu à proximité").get_by_role("radio", name="Restauration").check()
        expect(page.locator("ul.nearby")).to_contain_text("<img src=x onerror=alert(1)>")
        assert page.locator("img[src='x']").count() == 0
        shot(page, "09-proximite")
        assert not [e for e in errors if "dialog" in e or "pageerror" in e], errors

    geo()
    ctx.close()

    ctx, page, errors = new_page(browser, tiles=False)

    @scenario("Fond de carte indisponible : allées, positions et trajets restent affichés")
    def no_tiles():
        onboard(page, child_cm=None, budget=0)
        set_priority(page, "Peter Pan's Flight", "Incontournable")
        tab(page, "Carte")
        expect(page.locator(".map-note")).to_be_visible()
        # Footways are drawn once the walking network is loaded: wait for them, do not race.
        page.wait_for_function("document.querySelectorAll('path.map-footway').length > 100")
        expect(page.locator("path.route-next")).to_have_count(1)
        shot(page, "10-carte-sans-fond")

    no_tiles()
    ctx.close()

    ctx, page, errors = new_page(browser, osm=False, tiles=False)

    @scenario("Sans données OSM : trajets estimés signalés, planification maintenue")
    def no_osm():
        onboard(page, child_cm=None, budget=0)
        set_priority(page, "Peter Pan's Flight", "Incontournable")
        set_priority(page, "Big Thunder Mountain", "Incontournable")
        tab(page, "Carte")
        expect(page.get_by_text("Allées non disponibles : trajets estimés à vol d’oiseau.")).to_be_visible()
        expect(page.locator("ol.legs")).to_contain_text("estimation à vol d'oiseau")
        page.get_by_role("radiogroup", name="Type de lieu à proximité").get_by_role("radio", name="Toilettes").check()
        expect(page.locator(".nearby-empty")).to_be_visible()

    no_osm()
    ctx.close()

    for eligible in (True, False):
        ctx, page, errors = new_page(browser)
        page.clock.set_fixed_time(datetime(2026, 10, 22, 8, 40, tzinfo=PARIS))

        @scenario(f"Heures de Magie en Plus : {'groupe éligible, attraction avant 9 h 30' if eligible else 'groupe non éligible, départ à l’ouverture'}")
        def emh():
            onboard(page, child_cm=None, budget=0)
            tab(page, "Groupe")
            page.locator("input[name='source']").nth(1).check()
            page.get_by_label("Aller à l'heure").fill("08:40")
            page.get_by_role("button", name="Aller à cette heure").click()
            if eligible:
                page.get_by_label("Accès aux Heures de Magie en Plus").check()
                page.get_by_role("button", name="Enregistrer").click()
            tab(page, "Ma liste")
            set_priority(page, "Peter Pan's Flight", "Incontournable")
            set_priority(page, "Big Thunder Mountain", "Incontournable")
            tab(page, "Plan")
            expect(page.locator(".emh")).to_contain_text("08:30")
            expect(page.locator(".emh")).to_contain_text("Votre plan en profite" if eligible else "activez-les dans Groupe")
            tab(page, "Maintenant")
            arrival = page.locator(".facts div").nth(2).locator("dd").inner_text()
            hh, mm = map(int, arrival.split(":"))
            if eligible:
                expect(page.locator("#next-title")).to_have_text("Peter Pan's Flight")
                assert hh * 60 + mm < 9 * 60 + 30, arrival
            else:
                assert hh * 60 + mm >= 9 * 60 + 30, arrival

        emh()
        ctx.close()


def run_a11y(browser: Browser) -> None:
    axe = Path(os.environ.get("AXE_PATH", ROOT / "node_modules/axe-core/axe.min.js")).read_text()
    for scheme in ("light", "dark"):
        ctx, page, _ = new_page(browser, bypass_csp=True, color_scheme=scheme)

        @scenario(f"Accessibilité axe-core (WCAG A/AA), thème {'clair' if scheme == 'light' else 'sombre'}")
        def a11y():
            onboard(page)
            set_priority(page, "Peter Pan's Flight", "Incontournable")
            set_priority(page, "Big Thunder Mountain", "Incontournable")
            problems = []
            for name in ("Ma liste", "Maintenant", "Plan", "Carte", "Groupe"):
                tab(page, name)
                page.wait_for_timeout(150)
                if scheme == "dark":
                    shot(page, f"dark-{name.replace(' ', '-').lower()}")
                page.add_script_tag(content=axe)
                res = page.evaluate("axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })")
                for v in res["violations"]:
                    if v["impact"] in ("serious", "critical"):
                        problems.append(f"{name}: {v['id']} ({len(v['nodes'])}) {v['nodes'][0]['target']}")
            assert not problems, " | ".join(problems)

        a11y()
        ctx.close()


def run_easy(browser: Browser) -> None:
    """Carte Facilité, group beyond the card party, repeated rides (group of 7 with a child)."""
    axe = Path(os.environ.get("AXE_PATH", ROOT / "node_modules/axe-core/axe.min.js")).read_text()
    ctx, page, errors = new_page(browser, bypass_csp=True)
    state: dict[str, str] = {}

    @scenario("Carte Facilité : groupe de 7, les 2 hors carte en Single Rider")
    def e1():
        page.goto(URL)
        expect(page.get_by_role("heading", name="Votre groupe")).to_be_visible()
        page.get_by_label("Nombre de personnes").fill("7")
        page.get_by_label("Il y a un enfant dans le groupe").check()
        page.get_by_label("Taille du plus petit (cm)").fill("110")
        sr = page.get_by_label(re.compile("Single Rider"))
        expect(sr).to_be_disabled()
        page.get_by_label("Une personne a la Carte Facilité (ALD)").check()
        expect(page.get_by_text("Les 2 autres personnes font chaque attraction de leur côté")).to_be_visible()
        sr = page.get_by_label("Les 2 personnes hors carte acceptent la file Single Rider")
        expect(sr).to_be_enabled()
        sr.check()
        page.get_by_role("group", name="Parc de départ").get_by_role("radio", name="Adventure World").check()
        page.get_by_role("button", name="Commencer la visite").click()
        expect(page.get_by_role("heading", name="Ma liste")).to_be_visible()

    @scenario("Ma liste : nombre de fois par attraction")
    def e2():
        for ride in ["Spider-Man W.E.B. Adventure", "Ratatouille : L’Aventure Totalement Toquée de Rémy"]:
            set_priority(page, ride, "Incontournable")
        for ride in ["Cars Road Trip", "Rapunzel Tangled Spin", "Cars Quatre Roues Rallye", "Slinky Dog Zigzag Spin"]:
            set_priority(page, ride, "Si possible")
        spidey = page.get_by_role("group", name="Spider-Man W.E.B. Adventure")
        spidey.get_by_label("Nombre de fois aujourd'hui").select_option("3")
        expect(spidey.get_by_label("Nombre de fois aujourd'hui")).to_have_value("3")
        # Not offered until the ride is in the list.
        expect(page.get_by_role("group", name="Crush's Coaster").get_by_label("Nombre de fois aujourd'hui")).to_have_count(0)

    @scenario("Maintenant : inscription Carte Facilité et heure de retour donnée")
    def e3():
        tab(page, "Maintenant")
        expect(page.locator(".sign-kind")).to_contain_text("inscription carte facilité")
        state["ride"] = sign_title(page)
        expect(page.locator(".sign")).to_contain_text("Présentez la Carte Facilité à l'entrée Premier Access")
        shot(page, "easy-01-inscription")
        # Prefilled with the forecast return time; the user types the one actually given.
        expect(page.get_by_label("Heure de retour donnée")).to_have_value(re.compile(r"^1\d:\d{2}$"))
        page.get_by_label("Heure de retour donnée").fill("10:50")
        page.get_by_role("button", name="Inscription faite").click()
        panel = page.get_by_role("region", name=f"Carte Facilité : {state['ride']}")
        expect(panel).to_contain_text("Retour à partir de 10:50")
        expect(page.locator(".sign-kind")).not_to_contain_text("inscription")
        shot(page, "easy-02-apres-inscription")

    @scenario("Plan : retour avec la carte, répétitions numérotées, consignes hors carte")
    def e4():
        tab(page, "Plan")
        card_stop = page.locator(".stop.ride", has_text=state["ride"]).filter(has_text="Carte Facilité").first
        expect(card_stop).to_be_visible()
        meta = card_stop.locator(".stop-meta").first.inner_text()
        m = re.search(r"embarquement (\d{2}):(\d{2})", meta)
        assert m and int(m[1]) * 60 + int(m[2]) >= 10 * 60 + 50, meta
        expect(page.locator(".stop-name", has_text="Spider-Man W.E.B. Adventure (2e fois)")).to_be_visible()
        expect(page.locator(".stop-name", has_text="Spider-Man W.E.B. Adventure (3e fois)")).to_be_visible()
        expect(page.locator(".stop-meta", has_text="Hors carte (2)").first).to_be_visible()
        shot(page, "easy-03-plan")

    @scenario("Carte Facilité et sous-groupes : accessibilité axe-core (clair et sombre)")
    def e5():
        problems = []
        for scheme in ("light", "dark"):
            page.emulate_media(color_scheme=scheme)
            for name in ("Maintenant", "Plan", "Ma liste", "Groupe"):
                tab(page, name)
                page.wait_for_timeout(150)
                page.add_script_tag(content=axe)
                res = page.evaluate("axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })")
                for v in res["violations"]:
                    if v["impact"] in ("serious", "critical"):
                        problems.append(f"{scheme}/{name}: {v['id']} ({len(v['nodes'])}) {v['nodes'][0]['target']}")
        assert not problems, " | ".join(problems)

    for s in (e1, e2, e3, e4, e5):
        s()
    console_errors = [e for e in errors if "Failed to load resource" not in e]
    results.append(("Aucune erreur JavaScript (Carte Facilité)", not console_errors, "; ".join(console_errors)[:300] or "ok"))
    ctx.close()


def run_single(browser: Browser) -> None:
    ctx = browser.new_context(**PHONE)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    @scenario("Build fichier unique : démarre sans serveur ni réseau (mode démo)")
    def single():
        ctx.route("https://api.themeparks.wiki/**", lambda route: route.abort("internetdisconnected"))
        page.goto((ROOT / "dist-single/index.html").as_uri())
        expect(page.get_by_role("heading", name="Votre groupe")).to_be_visible()
        page.get_by_role("button", name="Commencer la visite").click()
        expect(page.locator(".status")).to_contain_text("Démo")
        assert not errors, errors

    single()
    ctx.close()


class StaticHandler(SimpleHTTPRequestHandler):
    """Serves the build with correct types for modules, manifest and service worker."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".html": "text/html; charset=utf-8",
    }

    def log_message(self, *_args) -> None:  # keep test output readable
        pass


def serve_dist() -> ThreadingHTTPServer:
    dist = ROOT / "dist"
    if not (dist / "index.html").is_file():
        sys.exit("dist/index.html introuvable : lancez d'abord `npm run build`.")
    server = ThreadingHTTPServer(("127.0.0.1", 4173), functools.partial(StaticHandler, directory=str(dist)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def annotate(level: str, title: str, message: str) -> None:
    """GitHub Actions annotation (readable in the run page and through the API)."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    # Workflow-command escaping: the message can never start a new command line.
    esc = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{level} title={title}::{esc}", flush=True)


def run_suite(suite, browser: Browser) -> list[tuple[str, str]]:
    """Runs one suite; on failure, reruns it once. Returns the scenarios that only passed on retry."""
    start = len(results)
    suite(browser)
    first = [(n, info) for n, ok, info in results[start:] if not ok]
    if not first:
        return []
    del results[start:]
    print(f"Nouvel essai de la suite {suite.__name__} ({len(first)} échec(s))", flush=True)
    suite(browser)
    still = {n for n, ok, _ in results[start:] if not ok}
    return [(n, info) for n, info in first if n not in still]


def main() -> int:
    server = serve_dist()
    flaky: list[tuple[str, str]] = []
    try:
        with sync_playwright() as p:
            # --disable-dev-shm-usage: CI containers often have a tiny /dev/shm.
            browser = p.chromium.launch(args=["--disable-dev-shm-usage"])
            for suite in (run, run_security, run_live, run_map, run_a11y, run_easy, run_single):
                flaky += run_suite(suite, browser)
            browser.close()
    finally:
        server.shutdown()
    width = max(len(n) for n, _, _ in results)
    for name, ok, info in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {info}")
        if not ok:
            annotate("error", "Recette en échec", f"{name} — {info}")
    for name, info in flaky:
        print(f"INSTABLE  {name}  (réussi au second essai ; 1er essai : {info})")
        annotate("warning", "Recette instable", f"{name} — réussi au second essai ; 1er essai : {info}")
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"\n{len(results) - failed}/{len(results)} scénarios réussis" + (f", {len(flaky)} instable(s)" if flaky else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
