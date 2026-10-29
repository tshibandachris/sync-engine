# Eden Gestion Desktop

Application Windows de gestion commerciale hors ligne d’Eden Devs Corp. Cette application est en cours de construction : le catalogue local et sa file de synchronisation sont en place, mais le parcours complet de caisse n’est pas encore prêt pour un usage commercial.

## Fonctionnalités disponibles dans cette version de travail

- Interface de bureau en français, adaptée aux écrans Windows.
- Catalogue local : créer, rechercher et modifier des produits.
- Prix et coûts enregistrés en nombres entiers, en francs congolais (CDF).
- Seuil d’alerte par produit ; la quantité en stock reste « non renseignée » tant qu’aucun mouvement de stock n’est enregistré.
- Base SQLite persistante, migrations versionnées et mode WAL.
- File d’attente durable des changements de catalogue, conservée quand Internet ou l’API est indisponible.
- Synchronisation via les contrats réels `POST /sync/pull` et `POST /sync/push`, avec clé d’idempotence et traitement des conflits.
- Interface isolée par le preload Electron : pas d’accès Node.js direct depuis le rendu.

## Ce qui reste à terminer avant un pilote en commerce

- Parcours complet de caisse : panier, paiement, création atomique de vente et lignes de vente.
- Ajustements et mouvements de stock, inventaire initial et validation de leur contrat de synchronisation côté serveur.
- Ouverture et clôture de caisse, rapprochement et reçus imprimables.
- Enrôlement sécurisé du terminal et stockage protégé du jeton. Les variables d’environnement ci-dessous sont uniquement un mécanisme de développement.
- Sauvegarde/restauration vérifiée, tests sur un Windows propre et essais métier de bout en bout.

Ne pas utiliser cette version pour enregistrer des ventes réelles tant que ces points ne sont pas validés.

## Données locales

La base de données est conservée à :

```text
%APPDATA%\EdenGestion\data.db
```

Le chemin est volontairement indépendant du nom affiché de l’application pour préserver les données lors du renommage. Ne pas supprimer ce fichier pour désinstaller ou mettre à jour l’application. Prévoir une sauvegarde avant toute opération de maintenance.

## Développement local

Prérequis : Windows 10/11 x64, Node.js 22 et npm.

Depuis le dossier `electron-app` :

```powershell
npm ci
$env:EDEN_SYNC_URL = "https://adresse-de-votre-api"
$env:EDEN_SYNC_TOKEN = "JETON_DE_TERMINAL"
npm run check
npm test
npm start
```

La synchronisation nécessite une URL d’API joignable et un jeton valide émis par le backend. L’application peut conserver le catalogue local lorsque l’API n’est pas joignable, mais elle ne peut pas synchroniser tant que l’accès n’est pas configuré.

## Construire l’installateur Windows

Sur Windows x64, avec les dépendances installées :

```powershell
npm run dist:win
```

Le fichier NSIS est produit dans `electron-app/dist-electron/`. Le script `dist:dir` permet de produire un répertoire de test sans installer.

Le workflow GitHub Actions **Eden Gestion Desktop — Windows installer** construit l’installateur sur un runner Windows, exécute les contrôles et tests, puis publie l’EXE comme artefact téléchargeable pendant 14 jours. Cet artefact est un paquet de test, pas encore une version de production signée.

## Identité Windows

Le paquet npm est `eden-gestion-desktop`. Le nom du produit, les raccourcis Bureau et menu Démarrer ainsi que le nom du programme de désinstallation sont **Eden Gestion Desktop**. NSIS utilise ce nom de produit pour son dossier d’installation par défaut. L’identifiant Electron est `corp.edendevs.edengestion.desktop`.

## Parcours d’installation prévu

1. Télécharger l’artefact de l’installateur depuis l’exécution du workflow GitHub Actions.
2. Ouvrir le fichier `.exe` sur un PC Windows x64 et suivre l’assistant NSIS.
3. Lancer **Eden Gestion Desktop** depuis le raccourci.
4. Vérifier le catalogue local et la connexion de synchronisation avant tout usage réel.

L’installation sur une machine propre, le premier démarrage, la mise à jour et la préservation des données doivent encore faire l’objet d’un test manuel documenté.

## Architecture

- `electron/main.cjs` : cycle de vie, IPC et orchestration de la synchronisation.
- `electron/preload.cjs` : API minimale exposée au rendu.
- `electron/renderer/` : interface de bureau.
- `electron/db/client.cjs` : SQLite, migrations, lecture/écriture du catalogue et application des pages reçues.
- `electron/sync/api-client.cjs` : client HTTP du Sync Engine.
- `electron/sync/outbox.cjs` : file persistante, validation du contrat et idempotence.
