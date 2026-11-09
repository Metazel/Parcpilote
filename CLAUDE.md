# ParcPilote : contexte pour les sessions Claude

À lire avant toute intervention sur ce dépôt. Les réponses au propriétaire (David Scemama, compte GitHub `Metazel`) se font en français, de façon synthétique, structurée et orientée action.

## Le produit

- Application web installable (PWA) d'aide à la visite de parcs d'attractions. À tout moment, elle donne la meilleure prochaine étape pour le groupe. Elle tient compte des attentes en direct, de la marche, des spectacles, des repas, du Single Rider, du Premier Access, de la Carte Facilité, des attractions répétées et du groupe scindé.
- Version : voir `package.json` (0.8.0 au 09/11/2026). Le site est publié sur https://metazel.github.io/Parcpilote/ à chaque push sur `main`.
- Parcs couverts (`src/data/destinations.ts`) :
  - **En direct** (données ThemeParks.wiki) : Disneyland Paris, Parc Astérix, Europa-Park, Futuroscope, Nigloland, Walibi Rhône-Alpes, Walibi Belgium, Walibi Holland, Gardaland, Mirabilandia et PortAventura World.
  - **Mode estimé** : Puy du Fou et Parc Spirou. Les attentes sont estimées et corrigeables ; les spectacles, séances et horaires sont saisis par le visiteur ou importés depuis le texte du programme qu'il colle (`src/data/programme.ts`, `importProgramme` du store).
- Seul Disneyland Paris a un référentiel détaillé, avec démo, Heures de Magie en Plus et Carte Facilité. Ailleurs, la structure (parcs, entrées) se déduit du flux en direct.

## Architecture

- Tout se passe dans le navigateur, **sans serveur ni compte**, et les données restent sur le téléphone (localStorage, chaque champ validé à la relecture). C'est un choix de sécurité et de frugalité : ne pas ajouter de serveur sans accord explicite.
- Stack :
  - Preact 11, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) ;
  - Vite 8 ; Leaflet pour la carte ;
  - Vitest pour les tests unitaires ; Playwright Python avec axe-core pour la recette ;
  - deux dépendances d'exécution seulement : `preact` et `leaflet`.
- Arborescence :
  - `src/domain/` : logique pure. Planificateur (course d'orientation avec fenêtres horaires), marche, temps, types.
  - `src/data/` : parcs proposés, adaptateur ThemeParks.wiki, OpenStreetMap (Overpass, format compact v3 par parc), mode estimé, démo, restauration.
  - `src/state/` : stockage validé, `AppStore`, calcul du plan dans un worker avec repli synchrone.
  - `src/ui/` : écrans Maintenant, Plan, Carte, Ma liste, Groupe.
- Origines réseau autorisées par la CSP : api.themeparks.wiki, Overpass, Nominatim, tuiles OpenStreetMap. Toute nouvelle origine doit être justifiée.

## Commandes

```bash
npm ci
npm run check          # types + lint + tests unitaires
npm run build && npm run build:single
python3 e2e/run_e2e.py # recette navigateur (serveur local, API simulées)
```

Depuis l'environnement Claude, api.themeparks.wiki, Overpass et Nominatim sont injoignables. La recette les simule ; seul le navigateur du visiteur les atteint réellement.

## Règles de travail (non négociables)

1. **Sécurité d'abord** (consigne du propriétaire : « Évites tout risque de vulnérabilité dans la conception »).
   - Moindre privilège.
   - Aucune donnée externe affichée ou stockée sans validation.
   - Liens externes en https uniquement (`safeUrl`).
   - Aucun secret dans le code, les workflows ou les tâches planifiées.
   - Ne jamais utiliser ni recopier un identifiant ou un jeton collé dans la conversation.
2. **Jamais de push direct sur `main`.** Travailler sur une branche, puis ouvrir une PR. Le ruleset « Protéger main » exige une PR et les contrôles « Vérifier », « Construire » et « Recette navigateur ».
3. **Règle de fusion « option A »**, validée par le propriétaire :
   - Claude fusionne seul les mises à jour Dependabot mineures ou correctives, et les correctifs de sécurité, une fois les contrôles verts.
   - Les évolutions explicitement demandées par le propriétaire sont fusionnées après CI verte.
   - Tout le reste attend son accord : mise à jour majeure, changement de réglages, ajout de dépendance ou de serveur.
4. **Exigences transverses du propriétaire**, à appliquer à chaque évolution :
   - Conformité : loi, CNIL, RGAA (accessibilité vérifiée par axe-core en recette).
   - Démarche : partir des cas d'usage, définir un MVP testé (métier, sécurité, limites, frugalité), évaluer la fiabilité des services tiers et le risque juridique.
   - Mise en ligne : tests fonctionnels obligatoires.
5. **Juridique** : ne pas reprendre le contenu d'un site tiers sans autorisation ou licence compatible. Exemple : les mentions légales du Puy du Fou interdisent toute reproduction sans accord écrit préalable.
6. À chaque version, mettre à jour le README, le numéro dans `package.json` et `package-lock.json`, et le nombre de tests cité dans le README et `ci.yml`.

## Outillage GitHub depuis Claude

- Accès au dépôt : `add_repo(owner="Metazel", repo="Parcpilote", access="push")`, puis clonage.
- API REST via `gh api repos/Metazel/Parcpilote/...`. GraphQL et `gh pr create` ou `gh pr merge` ne passent pas.
  - Ouvrir une PR : `gh api repos/Metazel/Parcpilote/pulls -f title=… -f head=<branche> -f base=main -F body=@fichier.md`
  - Fusionner : `gh api -X PUT repos/Metazel/Parcpilote/pulls/<n>/merge -f merge_method=squash`
- État des contrôles : `gh api repos/Metazel/Parcpilote/commits/<sha>/check-runs`. Les journaux et les artefacts ne sont pas lisibles, mais les annotations le sont.
- Les alertes Dependabot ne sont pas lisibles (droits restreints) ; contrôler en local avec `npm audit` et `pip-audit -r e2e/requirements.txt`.

## Automatisations en place

- **CI et publication** (`.github/workflows/ci.yml`) :
  - Déclenchée à chaque push et PR, avec une exécution planifiée le lundi à 05:17 UTC (audit).
  - Jobs : Vérifier, Construire, Recette navigateur, Publier (GitHub Pages, sur `main` seulement).
  - Permissions minimales par job ; actions épinglées par empreinte SHA.
- **Dependabot** (`.github/dependabot.yml`) : npm, pip (`/e2e`) et GitHub Actions, le lundi à 06:00, avec un délai de 14 jours sur les nouvelles versions.
- **Tâche planifiée Claude « Maintenance hebdo ParcPilote »** : le lundi à 10:47 (heure de Paris), avec approbation automatique et notifications push et e-mail. Elle applique l'option A et produit un rapport. Elle appartient au compte et n'est rattachée à aucune conversation.
- **Réglages du dépôt** : public, `main` par défaut, suppression des branches fusionnées activée, auto-merge GitHub désactivé.

## Suivi au 05/11/2026

- 0.7.0 publiée le 05/11 (PR #10 et #12 fusionnées).
- 0.8.0 (09/11) : recette en données réelles depuis le navigateur du propriétaire (flux ThemeParks.wiki et Overpass réels). Corrigés : Nigloland sans positions, parcs annexes exclus (`onlyParks`), jour de fermeture et prochaine ouverture (`scheduleOutlook`, `liveNotice`), horaires non publiés, nouvel essai OSM. Cas réels reproduits dans `tests/realdata.test.ts` (structures réelles, valeurs inventées).
- Alerte modérée minimatch (outillage eslint, hors application publiée) : décision du propriétaire le 05/11, **attendre le correctif amont**. La mise à jour de sécurité Dependabot échoue tant qu'eslint exige minimatch 10 ; dès qu'une version compatible sort, la PR Dependabot relève de l'option A. Ne pas forcer la version par `overrides`.
- Puy du Fou : **pas d'autorisation** de reprendre le programme (réponse du propriétaire le 05/11). La tâche quotidienne de reprise est abandonnée. Alternative livrée en 0.7.0 : lien vers le programme officiel et import du texte copié par le visiteur depuis une photo (analyse sur le téléphone, rien de republié).
- Phase 2 possible, avec accord (nouvelle dépendance) : OCR intégré (Tesseract.js auto-hébergé) si l'essai en parc montre que le copier-coller du téléphone gêne.
- Piste non prioritaire : Queue-Times comme source de secours. Elle impose un relais en ligne, car ce service n'autorise pas l'appel direct depuis le navigateur.
- À faire : un essai réel dans un parc autre que Disneyland Paris, car les flux n'ont été testés qu'en simulation. Prévu au Parc Spirou (ouvert les 7, 8 et 11/11, puis fermé jusqu'en avril) avec la fiche « 3_Recette_terrain_ParcPilote.md » du projet Claude. Les retours alimentent les tests de `programme.test.ts` avec des textes réécrits (ne jamais committer le texte d'un programme officiel : risque juridique).
