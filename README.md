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
- `migrations/` : migrations SQL versionnées pour PostgreSQL (jusqu'à 037).
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

## Administration des terminaux

Les terminaux nouvellement enrôlés restent en attente jusqu'à une décision administrative explicite. L'API expose :
- `GET /api/v1/admin/devices/pending` avec la permission IdP `devices:read` ;
- `POST /api/v1/admin/devices/:id/approve` avec `devices:approve` ;
- `POST /api/v1/admin/devices/:id/reject` avec `devices:reject` et une justification obligatoire ;
- `POST /api/v1/admin/devices/:id/revoke` avec `devices:revoke` et une justification obligatoire.

Les permissions proviennent exclusivement des claims validés du fournisseur d'identité. En mode à secret partagé, les jetons POS ordinaires restent sans permissions administratives ; un opérateur de confiance peut émettre un jeton dédié de 15 minutes avec `scripts/mint-device-admin-token.mjs`. En mode JWKS, l'IdP fournit les claims de permissions. Les transitions sont tenant-scoped, transactionnelles et journalisées dans `device_approval_events`. Une révocation invalide aussi la credential active. Le compte général `sync_app` ne peut ni appeler la fonction d'administration ni modifier directement les tables de terminaux.

La fonction de transition est exposée à un rôle-capacité PostgreSQL distinct, via `DEVICE_ADMIN_DATABASE_URL`. Le login `device_admin_login` doit rester distinct de `sync_app` et de `device_enrollment_login`. Configurez `DEVICE_ADMIN_PASSWORD` et l'URL dédiée avant de lancer les migrations. Le démarrage refuse une identité ou des privilèges non conformes.

## Enrôlement sécurisé des terminaux

Le parcours d'enrôlement initial utilise une connexion PostgreSQL dédiée, distincte du pool applicatif. La migration 036 retire à `sync_app` le droit d'exécuter la fonction atomique, d'insérer des devices, d'accéder aux codes d'activation et d'appeler les helpers d'enrôlement. Ces droits sont réservés au rôle-capacité `device_enrollment_executor` via une connexion dédiée. Le job `migrate` provisionne le login dédié à partir de `DEVICE_ENROLLMENT_PASSWORD`, et le backend refuse de démarrer si l'identité ou les privilèges de cette connexion ne correspondent pas au contrat attendu. Le script suit les migrations dans `schema_migrations` et reprend les migrations manquantes au lieu de s'arrêter au seul constat qu'une table existe. Voir [la procédure de provisionnement et la frontière de sécurité](docs/device-enrollment-db-isolation.md).

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
