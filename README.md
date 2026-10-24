# ParcPilote

Assistant de visite pour Disneyland Paris : à tout moment, la meilleure prochaine étape pour le groupe, en tenant compte des temps d'attente en direct, de la marche, des spectacles choisis, du Single Rider, du Premier Access et de la Carte Facilité. Version 0.3.0.

## Ce que fait l'application

- **Maintenant** : la prochaine étape sur un seul écran (marche, attente, heure d'arrivée, file conseillée), avec « Fait », « Passer » et « Signaler ».
- **Plan** : l'itinéraire de la journée sous forme de tracé, recalculé à chaque mise à jour ; « Faire maintenant » et « Retirer » par étape.
- **Ma liste** : attractions en « Incontournable » ou « Si possible », nombre de fois souhaité dans la journée (jusqu'à 5), séance de spectacle, filtrage automatique selon la taille du plus petit.
- **Carte interactive** : fond OpenStreetMap, attractions colorées selon l'attente, spectacles, restauration, toilettes et points d'eau (couches à cocher), géolocalisation avec précision, « À proximité » trié par temps de marche réel.
- **Circuit tracé** : tout le plan du jour dessiné sur les allées, étapes numérotées, prochain tronçon mis en avant, et pour chaque tronçon la durée, la distance et les allées empruntées (« par Main Street U.S.A., … »). Itinéraire à la demande depuis votre position vers n'importe quel lieu.
- **Groupe** : taille du groupe, enfant, Single Rider, budget Premier Access, rythme, poussette, pause déjeuner, parc de départ, Carte Facilité.
- **Carte Facilité (ALD)** : le titulaire s'inscrit à l'entrée Premier Access d'une attraction et reçoit une heure de retour égale à l'attente ; une seule inscription à la fois. Le plan place l'inscription, occupe le délai avec d'autres attractions en file normale, puis revient à l'heure de retour. L'heure donnée par le Cast Member est saisie dans l'application et remplace la prévision.
- **Groupe scindé** : le titulaire passe avec 4 accompagnateurs au plus, enfants compris ; au-delà, les autres personnes font chaque attraction de leur côté (Single Rider si accepté) et retrouvent le groupe à la sortie. Si aucune file ne leur permet de sortir à moins de 10 min du groupe, le plan le dit.
- **Heures de Magie en Plus** : lues dans les horaires officiels du jour ; si le groupe y a droit (hôtels Disney, certains pass), le plan commence par les attractions ouvertes avant l'ouverture officielle. Avant l'ouverture, les attractions fermées sont planifiées à partir de l'heure d'ouverture au lieu d'être écartées.
- **Alertes** dans l'application : panne, réouverture, attente qui chute, départ pour un spectacle, données trop anciennes.
- **Premier Access** : conseil chiffré (minutes gagnées, prix), puis saisie du créneau acheté qui devient une étape du plan.
- **Mode démo** déterministe : journée simulée, horloge accélérée, pannes déclenchables. Il sert aussi à préparer sa visite la veille.

## Démarrer

```bash
npm install
npm run dev            # développement
npm run check          # types stricts + lint + tests unitaires
npm run build          # PWA installable dans dist/
npm run build:single   # un seul fichier HTML autonome dans dist-single/
npm run test:e2e       # recette navigateur : pip install -r e2e/requirements.txt, après les deux builds
```

## Architecture

```
src/
  domain/   modèle, temps (Europe/Paris), marche, prévision d'attente, planificateur, conseil Premier Access
  data/     référentiel indicatif, adaptateur ThemeParks.wiki validé, simulation démo
  state/    persistance validée (localStorage) et store applicatif
  ui/       écrans Preact, styles
tests/      tests unitaires (Vitest)
e2e/        recette navigateur (Playwright)
```

- **100 % client** : aucun serveur, aucun compte.
- **Données officielles en direct** via [ThemeParks.wiki](https://themeparks.wiki/), qui relaie le flux de Disneyland Paris : temps d'attente standard et Single Rider, statuts (ouverte, fermée, en panne, en rénovation), créneaux et prix Premier Access, horaires du parc et Heures de Magie en Plus, séances de spectacles, restaurants. Si l'API est injoignable, l'app utilise les dernières données du jour (jusqu'à 90 min) puis la démo.
- **Pas d'appel direct aux points d'accès privés de l'application Disneyland Paris** : ils ne sont pas documentés, exigent des identifiants extraits de l'application et leur extraction automatisée est contraire aux conditions d'utilisation (et au droit des bases de données). Ils changent sans préavis, ce qui casserait l'app en plein parc. ThemeParks.wiki fournit les mêmes données par une API publique stable. DLPwait n'expose qu'un client Python sans API web documentée : non retenu.
- **OpenStreetMap** : allées piétonnes, toilettes, restauration et points d'eau, téléchargés une fois via Overpass (zone fixe des parcs, jamais votre position) puis gardés 30 jours sur l'appareil. Plus court chemin (Dijkstra) sur les allées ; les routes de service privées (coulisses) sont exclues. Sans ces données, repli sur l'estimation à vol d'oiseau, signalé à l'écran.
- **Planificateur** : problème de tournée avec fenêtres de temps et temps dépendants de l'heure. Construction gloutonne pondérée par la priorité (avec bonus d'urgence pour les files qui vont s'allonger), puis recherche locale (insertion, suppression, déplacement, échange), évaluée par simulation complète de la journée. Hystérésis : la prochaine étape ne change que si le gain dépasse 10 min.
- **Prévision v0.1** : temps affiché × courbe horaire générique, pondérée par l'horizon, corrigée par vos propres signalements.
- **Marche** : distance sur les allées OpenStreetMap (sinon vol d'oiseau × 1,35), vitesse selon le rythme, ×1,2 avec poussette, +10 min pour changer de parc.
- **Carte** : Leaflet 1.9.4 intégré au bundle (pas de CDN), chargé seulement à l'ouverture de l'onglet Carte. Tous les éléments dessinés sont stylés par classes CSS ; aucun HTML construit à partir des données.

## Sécurité et vie privée

- Deux dépendances d'exécution (Preact, Leaflet), versions figées. `npm audit` : 0 vulnérabilité.
- CSP stricte dans la PWA : `script-src 'self'`, `connect-src` limité à `api.themeparks.wiki` et `overpass-api.de`, images limitées à `tile.openstreetmap.org`, pas de `unsafe-inline`.
- Aucun HTML injecté : rendu Preact échappé ; `innerHTML` et `dangerouslySetInnerHTML` interdits par le lint.
- Toutes les données externes (API) et stockées (localStorage) sont validées champ par champ ; identifiants restreints à un jeu de caractères sûr, tailles bornées.
- Requêtes anonymes : sans cookies, sans référent, sans cache HTTP.
- Géolocalisation optionnelle, traitée uniquement sur l'appareil ; signalements locaux. Le serveur de tuiles voit la zone de carte affichée (inhérent à toute carte en ligne), jamais la position GPS.
- Données OpenStreetMap validées comme le reste (bornes géographiques, tailles, index) avant d'être utilisées ou relues depuis le cache.
- Hébergement recommandé : HTTPS statique, avec en en-têtes HTTP la même CSP plus `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` et `Referrer-Policy: no-referrer`.

## Mise en ligne

### GitHub (recommandé)

Le workflow `.github/workflows/ci.yml` vérifie, construit, teste puis publie l'application sur GitHub Pages à chaque push sur `main` :

| Job | Contenu |
| --- | --- |
| `verify` | types, lint, 93 tests unitaires, `npm audit` |
| `build` | PWA (`dist/`) et fichier unique (`dist-single/`) ; artefact Pages sur `main` |
| `e2e` | 30 scénarios Playwright, captures en artefact ; une suite en échec est rejouée une fois, les instabilités sont signalées en annotation |
| `deploy` | publication GitHub Pages (push ou lancement manuel sur `main`) |

Les pull requests passent les trois premiers jobs sans publier. Un passage hebdomadaire rejoue l'audit. Les actions sont épinglées par empreinte SHA, les permissions limitées par job ; le workflow est contrôlé par `actionlint` et `zizmor`. Dependabot (`.github/dependabot.yml`) propose chaque semaine les mises à jour npm, pip et GitHub Actions, avec un délai de 14 jours.

Dépôt : [Metazel/Parcpilote](https://github.com/Metazel/Parcpilote), avec **Settings > Pages > Source** réglé sur **GitHub Actions**. Toute modification passe par une pull request ; la fusion sur `main` publie le site à **https://metazel.github.io/Parcpilote/**. Variable de dépôt `SKIP_E2E=true` pour sauter la recette en cas de souci. Avec un compte GitHub Free, GitHub Pages exige un dépôt public ; un dépôt privé demande GitHub Pro.

### Autre hébergement

`npm run build` produit `dist/`, à déposer sur n'importe quel hébergement statique HTTPS (GitHub Pages, Netlify, Cloudflare Pages, serveur nginx). Le HTTPS est indispensable pour la géolocalisation et l'installation de la PWA. Les tuiles `tile.openstreetmap.org` conviennent à un usage personnel ; pour une diffusion large, prendre un fournisseur de tuiles avec clé (politique d'usage OSM).

## Limites connues

- Tailles minimales, durées, positions et options de file du référentiel sont **indicatives** ; l'API remplace positions, statuts et files en mode direct.
- Les prix Premier Access de l'API sont lus en centimes ; le créneau acheté est supposé durer 60 min.
- Les attractions ouvertes pendant les Heures de Magie en Plus sont celles que le flux officiel indique ouvertes ; la démo simule Fantasyland et Discoveryland.
- La qualité des trajets dépend de la cartographie OpenStreetMap des parcs ; une incohérence (trajet plus de 4 fois la ligne droite) est ignorée au profit de l'estimation.
- Carte Facilité : règles reprises du fonctionnement constaté (heure de retour = attente du moment, une inscription à la fois, 5 personnes au plus). L'inscription se fait à l'attraction ; l'attente résiduelle à l'entrée Premier Access est estimée à 5 min. Le créneau est supposé valable jusqu'à la fermeture.
- Groupe scindé : les enfants sont supposés accompagner le titulaire de la carte ; les tailles minimales s'appliquent à tout le groupe.
- Pas de notifications en arrière-plan (exigent un serveur push), pas de partage communautaire des signalements : prévus en phase 2 avec la collecte d'historique.

Application indépendante, non affiliée à Disney ni à Disneyland Paris.
