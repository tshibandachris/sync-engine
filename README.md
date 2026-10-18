Eden Devs Corp: Sync Engine & Eden Gestion
An offline-first point-of-sale (POS) and stock management system built for shops and small businesses in Sub-Saharan Africa, where power and internet cuts are routine.
This repository contains the backend (Sync Engine) and the desktop cashier client (Eden Gestion).




# Eden Devs Corp — Sync Engine & Eden Gestion

Bienvenue sur le dépôt principal d'Eden Devs Corp. Ce projet contient l'infrastructure backend (Sync Engine) et l'application client de caisse (Eden Gestion) conçus pour les commerces et PME en Afrique subsaharienne.

## 🎯 Vision du Produit

Eden Gestion est un logiciel de point de vente (POS) et de gestion de stock **offline-first**. Il est conçu pour continuer à fonctionner lors des coupures d'électricité et d'internet, et se synchronise automatiquement avec le serveur dès que la connexion est rétablie.

## 🏗 Architecture

Le projet est divisé en deux composants majeurs :

1. **Le Backend (Sync Engine)** : Une API NestJS multi-tenant (PostgreSQL, Drizzle ORM, SeaweedFS pour le stockage S3) qui gère l'authentification, la logique métier (ventes, stocks, caisses) et la synchronisation (push/pull).
2. **Le Client (Eden Gestion Desktop)** : Une application Electron (Windows) couplée à une base de données locale SQLite. Elle permet au caissier de travailler en totale autonomie hors-ligne et pousse ses données en arrière-plan.

## 🚀 Démarrage Rapide (Environnement Local)

### Prérequis
- **Docker Desktop** (pour le backend)
- **Node.js** v20+ et **Visual Studio Build Tools (C++)** (pour le client Electron)

### 1. Lancer le Backend (Sync Engine)

```powershell
# À la racine du projet
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
L'API sera accessible sur http://localhost:3000.

2. Lancer le Client (Eden Gestion)

```powershell
cd electron-app
npm install
```

Configurez l'URL de l'API et un jeton JWT valide, puis démarrez :

```powershell
$env:EDEN_SYNC_URL = "http://localhost:3000"
$env:EDEN_SYNC_TOKEN = "votre_jeton_genere_via_mint-token"
npm start
```

📁 Structure du Dépôt

· /src : Code source de l'API NestJS (contrôleurs, services de synchronisation, schémas Drizzle).
· /migrations : Scripts SQL (001 à 025) pour l'initialisation de la base de données PostgreSQL (incluant les extensions POS).
· /electron-app : Code source complet de l'application client (main, preload, renderer, SQLite local).
· /test : Plus de 250 tests d'intégration et de contrat (incluant la validation RLS, le POS et la synchronisation multi-appareils).
· /docs : Documentation technique (HANDOFF, plan de test POS, architecture Electron).

🔐 Sécurité et Données

· Multi-tenant strict : Chaque donnée est isolée par tenant_id via PostgreSQL Row-Level Security (RLS).
· Immuabilité comptable : Les tables sales, sale_lines et stock_movements sont protégées par des triggers SQL. Aucune vente ne peut être modifiée ou supprimée (seule une vente miroir d'annulation "void" est autorisée).
· Zéro secret dans le code : Les variables d'environnement (.env.prod) contiennent les secrets de production et ne doivent jamais être commitées.

🧪 Tests

Pour vérifier que le backend et les migrations sont sains :

```powershell
npx tsc --noEmit
npx vitest run
```

👨‍💻 Auteur

Développé par Eden Devs Corp (Kinshasa, RDC).
