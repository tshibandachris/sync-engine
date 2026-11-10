# Administration sécurisée des terminaux POS

## Contrat HTTP

Toutes les routes sont protégées par un JWT validé par le mode JWKS/IdP configuré. Le tenant et l'acteur sont extraits du JWT ; ils ne sont jamais acceptés depuis le corps de la requête.

| Méthode | Route | Permission IdP | Effet |
|---|---|---|---|
| GET | `/api/v1/admin/devices/pending` | `devices:read` | Liste les terminaux en attente du tenant du JWT |
| POST | `/api/v1/admin/devices/:id/approve` | `devices:approve` | Approuve un terminal en attente ou précédemment rejeté |
| POST | `/api/v1/admin/devices/:id/reject` | `devices:reject` | Rejette un terminal en attente ; justification obligatoire |
| POST | `/api/v1/admin/devices/:id/revoke` | `devices:revoke` | Révoque un terminal approuvé et sa credential active ; justification obligatoire |

Les claims `permissions` ou `scope` sont extraits par `JwtAuthGuard` après validation de la signature du JWT. Le service refuse les appels sans la permission exacte. Les jetons de développement sans permission n'accordent aucun accès administratif.

En mode de production à secret partagé (`AUTH_ALLOW_SHARED_SECRET=true`), les jetons POS émis par `scripts/mint-token.mjs` ne disposent d'aucune permission administrative et ne peuvent pas accéder à ces routes. Un opérateur de confiance peut créer un jeton administratif limité à 15 minutes avec `scripts/mint-device-admin-token.mjs`, en choisissant explicitement une liste de permissions autorisées. Le guard exige aussi le claim `token_use=device_admin` dans ce mode. Ne jamais transmettre `JWT_SECRET` ou ce jeton à un terminal POS.

En mode JWKS, le fournisseur d'identité peut émettre les permissions dans les claims `permissions` ou `scope`. Dans les deux modes, seule la permission exacte de la route est acceptée.

## Transitions

- `pending_approval -> approved` : événement `approved`, horodatage et acteur enregistrés ; le terminal doit être actif et posséder une credential ES256 active.
- `pending_approval -> rejected` : événement `rejected`, justification obligatoire.
- `rejected -> approved` : nouvelle décision explicite, événement `approved`.
- `approved -> revoked` : événement `revoked`, justification obligatoire et révocation de toutes les credentials actives du terminal.
- Les autres transitions échouent en conflit ; un terminal révoqué n'est pas réactivé par cette API.

La transition, la mise à jour du device, la révocation éventuelle de credential et l'événement append-only sont effectués dans une seule fonction SQL transactionnelle. Les lignes sont verrouillées avec `FOR UPDATE` afin d'arbitrer les décisions concurrentes.

## Frontière PostgreSQL

- `sync_app` : lecture métier et contrôle de confiance ; aucun droit direct de modification des devices ou des événements d'approbation, et aucun droit EXECUTE sur la fonction d'administration.
- `device_admin_executor` : rôle-capacité NOLOGIN, sans privilège direct sur les tables ; EXECUTE uniquement sur `transition_device_approval(...)`.
- `device_admin_function_owner` : rôle SECURITY DEFINER NOLOGIN, NOINHERIT, NOSUPERUSER et NOBYPASSRLS ; privilèges minimaux de lecture/mise à jour nécessaires, sans propriété des tables.
- `device_admin_login` : login INHERIT dédié, membre du rôle-capacité sans droit SET ROLE ; jamais membre de `sync_app` ou du rôle d'enrôlement.

Le rôle de migration provisionne `device_admin_login` depuis `DEVICE_ADMIN_PASSWORD`. L'application utilise `DEVICE_ADMIN_DATABASE_URL` et vérifie l'identité de session, les memberships, les privilèges, les propriétaires et l'absence d'accès direct aux tables avant d'écouter sur le port HTTP.

## Configuration

Ajouter aux secrets de déploiement :
- `DEVICE_ADMIN_PASSWORD` : secret fort et indépendant ;
- `DEVICE_ADMIN_DATABASE_URL` : connexion à `device_admin_login` avec ce secret.

Le compte d'administration PostgreSQL est distinct des identifiants de l'application et de l'enrôlement. En production, le fournisseur d'identité doit émettre les permissions ci-dessus pour les administrateurs autorisés. Aucune permission n'est accordée par défaut.

## Tests attendus

La suite `test/device-admin.approval.spec.ts` couvre les permissions, la liste tenant-scoped, l'approbation, le rejet, la révocation de credential, les transitions et l'isolation inter-tenant. Elle utilise trois rôles PostgreSQL distincts et Testcontainers.
