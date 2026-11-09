# ParcPilote

Assistant de visite de parcs d'attractions : à tout moment, la meilleure prochaine étape pour le groupe, en tenant compte des temps d'attente en direct, de la marche, des spectacles choisis, des repas, du Single Rider, du Premier Access et de la Carte Facilité. Version 0.9.0.

| Parc | Données |
| --- | --- |
| Disneyland Paris (2 parcs, référentiel détaillé, démo, Heures de Magie en Plus, Carte Facilité) | En direct |
| Parc Astérix, Europa-Park, Futuroscope, Nigloland, Walibi Rhône-Alpes, Walibi Belgium, Walibi Holland, Gardaland, Mirabilandia, PortAventura World | En direct (liste, positions, attentes, séances et horaires lus dans le flux ; parc principal seulement : sans Rulantica ni Traumatica à Europa-Park, sans Ferrari Land ni Caribe Aquatic Park à PortAventura) |
| Puy du Fou, Parc Spirou Provence | Mode estimé : pas de flux public ; spectacles et attractions issus d'OpenStreetMap ou ajoutés par vous, attentes estimées à corriger sur place, séances, horaires, attentes et fermetures saisis ou importés depuis le programme du jour (texte copié d'une photo) |

## Ce que fait l'application

### Les moments de la visite (0.9.0)

| Moment | Ce que fait l'application |
| --- | --- |
| Je programme une visite à venir | **Plan → Jour** : plan prévisionnel du jour choisi parmi les ouvertures publiées (sinon les deux semaines à venir, horaires habituels à vérifier), avec des attentes estimées d'après une journée type. La journée en cours n'est pas modifiée. Le jour J, le plan suit les attentes en direct. |
| Un parc ou deux | Disneyland Paris : deux parcs et parc de départ. Le prévisionnel montre ce qui tient dans la journée et ce qui n'y tient pas, avec la raison. |
| Manger au parc, au restaurant ou non | Groupe : déjeuner et dîner sur le pouce, à table (avec réservation), en pique-nique ou sans pause, repris dans le prévisionnel. |
| Les enfants d'abord | Ma liste : filtre **« Pour les enfants »** (attractions douces et accessibles à la taille du plus petit, spectacles), puis « Incontournable » pour leurs préférées. |
| Arrivé à l'entrée, par où commencer ? | Carte **« Par où commencer »** : l'heure à laquelle être à l'entrée (30 min avant l'ouverture, ou avant les Heures de Magie en Plus) et les trois premières étapes. Accessible depuis Maintenant quand le parc n'est pas encore ouvert. |
| Toilettes, eau, faim | Maintenant → **« Un besoin ? »** : les trois lieux les plus proches en minutes de marche, et l'itinéraire tracé sur la carte. |
| Un imprévu décale le programme | **« Pause » de 15, 30 ou 45 min** : le plan repart après. **« Plus tard »** : l'attraction revient dans le plan au bout d'une heure, sans être perdue comme avec « Passer ». |
| Pas de réseau dans le parc | **« Préparer le hors-ligne »** : liste du parc, allées et services gardés sur le téléphone (le fond de carte, lui, demande le réseau). |

### Toutes les fonctions

- **Maintenant** : la prochaine étape sur un seul écran (marche, attente, heure d'arrivée, file conseillée), avec « Fait », « Passer » et « Signaler ».
- **Plan** : l'itinéraire de la journée sous forme de tracé, recalculé à chaque mise à jour ; « Faire maintenant » et « Retirer » par étape.
- **Ma liste** : attractions en « Incontournable » ou « Si possible », nombre de fois souhaité dans la journée (jusqu'à 5), séance de spectacle, filtrage automatique selon la taille du plus petit.
- **Carte interactive** : fond OpenStreetMap, attractions colorées selon l'attente, spectacles, restauration, toilettes et points d'eau (couches à cocher), géolocalisation avec précision, « À proximité » trié par temps de marche réel.
- **Circuit tracé** : tout le plan du jour dessiné sur les allées, étapes numérotées, prochain tronçon mis en avant, et pour chaque tronçon la durée, la distance et les allées empruntées (« par Main Street U.S.A., … »). Itinéraire à la demande depuis votre position vers n'importe quel lieu.
- **Groupe** : taille du groupe, enfant, Single Rider, budget Premier Access, rythme, poussette, pause déjeuner, parc de départ, Carte Facilité.
- **Carte Facilité (ALD)** : le titulaire s'inscrit à l'entrée Premier Access d'une attraction et reçoit une heure de retour égale à l'attente ; une seule inscription à la fois. Le plan place l'inscription, occupe le délai avec d'autres attractions en file normale, puis revient à l'heure de retour. L'heure donnée par le Cast Member est saisie dans l'application et remplace la prévision.
- **Groupe scindé** : le titulaire passe avec 4 accompagnateurs au plus, enfants compris ; au-delà, les autres personnes font chaque attraction de leur côté (Single Rider si accepté) et retrouvent le groupe à la sortie. Si aucune file ne leur permet de sortir à moins de 10 min du groupe, le plan le dit.
- **Heures de Magie en Plus** : lues dans les horaires officiels du jour ; si le groupe y a droit (hôtels Disney, certains pass), le plan commence par les attractions ouvertes avant l'ouverture officielle. Avant l'ouverture, les attractions fermées sont planifiées à partir de l'heure d'ouverture au lieu d'être écartées.
- **Repas** : déjeuner et dîner, chacun « sur le pouce » (comptoir, kiosque, food truck), « à table » (restaurant avec service, avec heure de réservation) ou en pique-nique. Le plan choisit le lieu le plus pratique sur le parcours, ou celui que vous indiquez dans Ma liste, compte la marche et la durée moyenne (30, 75 ou 40 min, modifiables) et se cale sur la réservation. À Disneyland Paris, l'aire de pique-nique est hors des parcs : la sortie et le nouveau contrôle de sécurité (15 min) sont comptés. Restaurants à table, comptoirs et aires de pique-nique sur la carte ; lien vers le menu (OpenStreetMap) ou vers la page officielle des restaurants.
- **Alertes** dans l'application : panne, réouverture, attente qui chute, départ pour un spectacle, données trop anciennes.
- **Premier Access** : conseil chiffré (minutes gagnées, prix), puis saisie du créneau acheté qui devient une étape du plan.
- **Plusieurs parcs** : choix du parc dans Groupe (dès le premier écran) ; changer de parc recommence la journée et garde la liste de chaque parc. Pour les parcs autres que Disneyland Paris, la structure (parcs, positions des entrées) est déduite du flux en direct et la dernière liste reçue est gardée 30 jours pour les journées sans réseau. Si le flux tombe : dernières données du jour, puis mode estimé.
- **Mode estimé** : « Ajouter une attraction ou un spectacle » (nom, type, durée), saisie des séances lues sur le programme, horaires du jour modifiables ; le plan les prend en compte comme des données en direct.
- **Importer le programme du jour** (mode estimé) : photographiez le programme ou un panneau, copiez le texte reconnu par le téléphone (Texte en direct sur iPhone, Google Lens sur Android) et collez-le. L'application reconnaît sur l'appareil les horaires du parc, les séances par spectacle, les attentes affichées et les attractions fermées, les rattache aux lieux connus, puis vous montre un aperçu à cocher avant de l'ajouter à la journée. Les spectacles inconnus ne sont ajoutés que si vous les cochez. Le texte n'est ni envoyé ni conservé.
- **Liens officiels** : site de chaque parc dans Ma liste et dans Groupe ; programme officiel (Puy du Fou) ou calendrier (Parc Spirou) dans le bloc d'import.
- **Mode démo** déterministe (Disneyland Paris) : journée simulée, horloge accélérée, pannes déclenchables. Il sert aussi à préparer sa visite la veille.

## Habillage et accessibilité

- **Le billet** : la prochaine étape se présente comme un billet d'attraction (bandeau à la couleur du parc, perforation, chiffres en grand). Le reste de l'interface reste sobre ; les couleurs des parcs ne servent qu'à structurer (bandeau, tracé du plan, repères de zone).
- **Typographies auto-hébergées** (licence OFL, aucune requête vers un tiers) : Bricolage Grotesque pour les titres et les chiffres, Atkinson Hyperlegible Next pour le texte, dessinée pour les personnes malvoyantes.
- **Adaptatif** : barre d'onglets en bas sur téléphone, navigation latérale et mises en page sur deux colonnes à partir de 1000 px ; thèmes clair et sombre ; mode contraste élevé de Windows.
- **RGAA 4.1** : liens d'évitement, titre de page par vue, hiérarchie de titres, focus visible, erreurs de saisie liées au champ avec focus, liens « nouvelle fenêtre » annoncés, texte à 200 % et espacement du texte augmenté sans perte, aucun défilement horizontal à 320 px, cibles tactiles de 44 px, animations coupées si l'appareil le demande. Contrastes vérifiés par calcul (texte ≥ 7:1, texte secondaire ≥ 4,5:1, commandes ≥ 3:1). Vérifié automatiquement à chaque version (axe-core WCAG 2.2 AA en clair et sombre, sur téléphone et grand écran, et 10 scénarios RGAA dédiés) ; conformité non auditée par un tiers.
- **Performance** : le plan est calculé dans un worker, l'interface ne se bloque jamais (pire interaction mesurée à 120 ms sur téléphone simulé, contre 400 ms auparavant, aucune tâche longue) ; rendu différé des zones hors écran dans Ma liste ; carte chargée à la demande.

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
  data/     parcs proposés, référentiel indicatif (Disneyland Paris), adaptateur ThemeParks.wiki validé, mode estimé, simulation démo
  state/    persistance validée (localStorage), store applicatif, client du worker de planification
  workers/  calcul du plan hors du fil principal
  ui/       écrans Preact, styles, polices auto-hébergées
tests/      tests unitaires (Vitest)
e2e/        recette navigateur (Playwright)
```

- **100 % client** : aucun serveur, aucun compte.
- **Données officielles en direct** via [ThemeParks.wiki](https://themeparks.wiki/), qui relaie le flux de Disneyland Paris : temps d'attente standard et Single Rider, statuts (ouverte, fermée, en panne, en rénovation), créneaux et prix Premier Access, horaires du parc et Heures de Magie en Plus, séances de spectacles, restaurants. Si l'API est injoignable, l'app utilise les dernières données du jour (jusqu'à 90 min) puis la démo (Disneyland Paris) ou le mode estimé (autres parcs).
- **Pas d'appel direct aux points d'accès privés de l'application Disneyland Paris** : ils ne sont pas documentés, exigent des identifiants extraits de l'application et leur extraction automatisée est contraire aux conditions d'utilisation (et au droit des bases de données). Ils changent sans préavis, ce qui casserait l'app en plein parc. ThemeParks.wiki fournit les mêmes données par une API publique stable. DLPwait n'expose qu'un client Python sans API web documentée : non retenu.
- **OpenStreetMap** : allées piétonnes, toilettes, restauration et points d'eau, téléchargés une fois par parc via Overpass (zone fixe autour du parc, jamais votre position ; la zone est gardée avec les données et revérifiée) puis gardés 30 jours sur l'appareil. Plus court chemin (Dijkstra) sur les allées ; les routes de service privées (coulisses) sont exclues. Sans ces données, repli sur l'estimation à vol d'oiseau, signalé à l'écran.
- **Planificateur** : problème de tournée avec fenêtres de temps et temps dépendants de l'heure. Construction gloutonne pondérée par la priorité (avec bonus d'urgence pour les files qui vont s'allonger), puis recherche locale (insertion, suppression, déplacement, échange), évaluée par simulation complète de la journée. Hystérésis : la prochaine étape ne change que si le gain dépasse 10 min.
- **Prévision v0.1** : temps affiché × courbe horaire générique, pondérée par l'horizon, corrigée par vos propres signalements.
- **Marche** : distance sur les allées OpenStreetMap (sinon vol d'oiseau × 1,35), vitesse selon le rythme, ×1,2 avec poussette, +10 min pour changer de parc.
- **Carte** : Leaflet 1.9.4 intégré au bundle (pas de CDN), chargé seulement à l'ouverture de l'onglet Carte. Tous les éléments dessinés sont stylés par classes CSS ; aucun HTML construit à partir des données.

## Sécurité et vie privée

- Deux dépendances d'exécution (Preact, Leaflet), versions figées. `npm audit` : 0 vulnérabilité.
- CSP stricte dans la PWA : `script-src 'self'`, `connect-src` limité à `api.themeparks.wiki` et `overpass-api.de`, images limitées à `tile.openstreetmap.org`, pas de `unsafe-inline`.
- Aucun HTML injecté : rendu Preact échappé ; `innerHTML` et `dangerouslySetInnerHTML` interdits par le lint.
- Toutes les données externes (API) et stockées (localStorage) sont validées champ par champ ; identifiants restreints à un jeu de caractères sûr, tailles bornées.
- Texte de programme collé : 5 000 caractères au plus, caractères de contrôle et de direction retirés, libellés réduits à du texte simple (80 caractères), heures et attentes bornées, chaque valeur revérifiée par le store avant enregistrement.
- Requêtes anonymes : sans cookies, sans référent, sans cache HTTP.
- Géolocalisation optionnelle, traitée uniquement sur l'appareil ; signalements locaux. Le serveur de tuiles voit la zone de carte affichée (inhérent à toute carte en ligne), jamais la position GPS.
- Données OpenStreetMap validées comme le reste (bornes géographiques, tailles, index) avant d'être utilisées ou relues depuis le cache.
- Hébergement recommandé : HTTPS statique, avec en en-têtes HTTP la même CSP plus `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` et `Referrer-Policy: no-referrer`.

## Mise en ligne

### GitHub (recommandé)

Le workflow `.github/workflows/ci.yml` vérifie, construit, teste puis publie l'application sur GitHub Pages à chaque push sur `main` :

| Job | Contenu |
| --- | --- |
| `verify` | types, lint, 155 tests unitaires, `npm audit` |
| `build` | PWA (`dist/`) et fichier unique (`dist-single/`) ; artefact Pages sur `main` |
| `e2e` | 53 scénarios Playwright (dont accessibilité RGAA), captures en artefact ; une suite en échec est rejouée une fois, les instabilités sont signalées en annotation |
| `deploy` | publication GitHub Pages (push ou lancement manuel sur `main`) |

Les pull requests passent les trois premiers jobs sans publier. Un passage hebdomadaire rejoue l'audit. Les actions sont épinglées par empreinte SHA, les permissions limitées par job ; le workflow est contrôlé par `actionlint` et `zizmor`. Dependabot (`.github/dependabot.yml`) propose chaque semaine les mises à jour npm, pip et GitHub Actions, avec un délai de 14 jours.

Dépôt : [Metazel/Parcpilote](https://github.com/Metazel/Parcpilote), avec **Settings > Pages > Source** réglé sur **GitHub Actions**. Toute modification passe par une pull request ; la fusion sur `main` publie le site à **https://metazel.github.io/Parcpilote/**. Variable de dépôt `SKIP_E2E=true` pour sauter la recette en cas de souci. Avec un compte GitHub Free, GitHub Pages exige un dépôt public ; un dépôt privé demande GitHub Pro.

### Autre hébergement

`npm run build` produit `dist/`, à déposer sur n'importe quel hébergement statique HTTPS (GitHub Pages, Netlify, Cloudflare Pages, serveur nginx). Le HTTPS est indispensable pour la géolocalisation et l'installation de la PWA. Les tuiles `tile.openstreetmap.org` conviennent à un usage personnel ; pour une diffusion large, prendre un fournisseur de tuiles avec clé (politique d'usage OSM).

## Fiabilité des données réelles (0.8.0)

Recette faite le 09/11/2026 sur les vrais flux ThemeParks.wiki et OpenStreetMap des 11 parcs en direct, depuis un navigateur. Constats et correctifs :

- **Nigloland** : le flux ne donne aucune position, et l'application écartait donc tout le parc (« données inaccessibles »). Désormais, le centre connu du parc sert d'entrée, puis les attractions prennent leur position OpenStreetMap quand le nom correspond. Les autres restent à l'entrée.
- **Parcs annexes** : Europa-Park mêlait Rulantica (parc aquatique) et Traumatica (événement), et PortAventura mêlait Ferrari Land et Caribe Aquatic Park, qui demandent un autre billet. Seul le parc principal est gardé.
- **Jour de fermeture** : un parc fermé ce jour-là (calendrier publié sans ouverture aujourd'hui) n'est plus présenté comme ouvert. Un bandeau donne la prochaine ouverture, et les statuts « en service » périmés du flux sont ignorés.
- **Horaires non publiés** (Parc Astérix, Mirabilandia, Walibi Holland au 09/11) : un bandeau indique que les horaires habituels sont supposés et renvoie au site officiel.
- **Overpass surchargé** (erreur 502 constatée) : un téléchargement OpenStreetMap échoué est retenté au rafraîchissement suivant au lieu d'être abandonné pour la session.

## Limites connues

- Hors Disneyland Paris, tailles minimales et durées ne sont pas publiées par les flux : le filtrage par taille ne s'applique pas, la durée d'une attraction est estimée à 5 min. Les aires de pique-nique viennent d'OpenStreetMap ; celles à plus de 250 m des attractions sont supposées hors du parc (retour compté). Vérifiez le règlement du parc.
- Puy du Fou et Parc Spirou : aucune source publique de temps d'attente ni de programme, et pas d'autorisation de reprise du programme du Puy du Fou ; l'import repose sur le texte que le visiteur copie lui-même. Tout ce qui est estimé est indiqué comme tel.
- Import du programme : la reconnaissance du texte d'une photo dépend du téléphone ; l'analyse tolère une faute de lecture par mot mais peut se tromper sur un programme très mis en page, d'où l'aperçu à vérifier. Une fermeture importée compte 30 min, comme un signalement.
- Tailles minimales, durées, positions et options de file du référentiel sont **indicatives** ; l'API remplace positions, statuts et files en mode direct.
- Les prix Premier Access de l'API sont lus en centimes ; le créneau acheté est supposé durer 60 min.
- Les attractions ouvertes pendant les Heures de Magie en Plus sont celles que le flux officiel indique ouvertes ; la démo simule Fantasyland et Discoveryland.
- La qualité des trajets dépend de la cartographie OpenStreetMap des parcs ; une incohérence (trajet plus de 4 fois la ligne droite) est ignorée au profit de l'estimation.
- Carte Facilité : règles reprises du fonctionnement constaté (heure de retour = attente du moment, une inscription à la fois, 5 personnes au plus). L'inscription se fait à l'attraction ; l'attente résiduelle à l'entrée Premier Access est estimée à 5 min. Le créneau est supposé valable jusqu'à la fermeture.
- Groupe scindé : les enfants sont supposés accompagner le titulaire de la carte ; les tailles minimales s'appliquent à tout le groupe.
- Plan prévisionnel : attentes typiques selon l'heure (et l'intensité de l'attraction quand la liste la connaît, à Disneyland Paris), pas une prévision de fréquentation du jour ; séances de spectacles inconnues avant le jour même, sauf pour Disneyland Paris (journée type de la démo).
- Futuroscope : le flux donne des noms en anglais et mêle les bassins de l'Aquascope aux attractions du parc ; à filtrer à la main dans Ma liste.
- Pas de notifications en arrière-plan (exigent un serveur push), pas de partage communautaire des signalements : prévus en phase 2 avec la collecte d'historique.

Application indépendante, non affiliée aux parcs proposés.
