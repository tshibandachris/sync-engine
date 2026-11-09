# Eden Devs Corp — Sync Engine & Eden Gestion

Dépôt du système de gestion commerciale **Eden Gestion**, composé d'une API backend multi-tenant (Sync Engine) et d'un client de caisse Windows offline-first.

Le produit vise les commerces et PME qui doivent continuer à travailler pendant les coupures d'électricité ou d'accès à Internet, puis synchroniser leurs opérations lorsque la connexion revient.

## Architecture

- **Backend — Sync Engine :** API NestJS, PostgreSQL, Drizzle ORM, politiques Row-Level Security (RLS), synchronisation push/pull et stockage S3 compatible via SeaweedFS.
- **Client — Eden Gestion Desktop :** application Electron pour Windows x64, base locale SQLite, catalogue local et file d'attente durable des changements.

## Démarrage local

### Prérequis

- Node.js 20 ou supérieur pour le backend.
- Docker et Docker Compose pour les services locaux.
- Windows x64 et Node.js 22 pour le client Electron.
- Visual Studio Build Tools avec les composants C++ peuvent être nécessaires pour les modules natifs.

### 1. Backend

À la racine du dépôt, configurez les variables requises dans un fichier d'environnement local non versionné. Pour démarrer les services locaux :

```powershell
docker compose up -d
```

Pour l'environnement de production, utilisez uniquement une configuration de secrets préparée et vérifiée :

```powershell
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

L'API utilise le port 3000 avec la configuration locale par défaut.

### 2. Client desktop

```powershell
cd electron-app
npm ci
npm run check
npm test
npm start
```

Le client nécessite une URL d'API joignable et un jeton d'appareil valide. En mode développement non empaqueté, `EDEN_SYNC_TOKEN` peut servir au bootstrap local. Les builds empaquetés ne doivent pas utiliser cette variable comme mécanisme d'authentification.

## Structure du dépôt

- `src/` : API NestJS, services métier, synchronisation, sécurité et observabilité.
- `migrations/` : 30 migrations SQL versionnées pour PostgreSQL.
- `electron-app/` : client Windows Electron, SQLite, interface, sécurité IPC et synchronisation.
- `test/` : tests backend et d'intégration.
- `electron-app/test/` : tests du client desktop et simulations.
- `docs/` : contrats techniques, architecture, sécurité et plans de validation.
- `.github/workflows/` : contrôles CI, tests Electron et packaging Windows.

## Sécurité et intégrité des données

- **Isolation multi-tenant :** les données sont protégées par tenant, notamment au moyen de PostgreSQL RLS.
- **Opérations métier :** les ventes et mouvements de stock s'appuient sur des migrations et contrats dédiés.
- **Synchronisation :** l'outbox locale conserve les opérations en attente et utilise l'idempotence pour limiter les doublons.
- **Secrets :** ne jamais versionner de jetons, mots de passe, clés ou fichiers d'environnement contenant des secrets.
- **Client desktop :** le jeton persistant doit être conservé par le stockage sécurisé du processus principal Electron.

## Contrôles

Depuis la racine :

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Depuis `electron-app/` :

```powershell
npm ci
npm run check
npm test
```

Le succès de la CI et des tests automatisés ne remplace pas les essais d'installation, de sauvegarde/restauration, de synchronisation et de validation métier sur une machine Windows cible.

## État de préparation

Le backend et le client desktop contiennent déjà des composants fonctionnels importants. Toutefois, le parcours complet de caisse et sa validation terrain, l'intégration bout en bout de l'activation par code, ainsi que les tests d'installation et de mise à jour sur machine Windows propre doivent être vérifiés avant tout usage commercial.

## Documentation

Consulter les documents du dossier `docs/`, en particulier :

- `docs/electron-architecture.md`
- `docs/electron-packaging.md`
- `docs/pos-sales-push-contract.md`
- `docs/courrier-security-audit.md`

---
Eden Devs Corp — Kinshasa, RDC
