# Spécification technique — identité, credentials et approbation des terminaux

> **Statut :** spécification cible proposée, non implémentée.
> **Périmètre :** PostgreSQL/Drizzle, API NestJS, IdP, Electron Windows et synchronisation.
> **Branche documentaire :** `docs/device-activation-contract`.
> **Règle :** aucune migration ni modification fonctionnelle n'est introduite par ce document.

## 1. Référence de l'état actuel vérifié

Cette section décrit les migrations et le code consultés sur la branche documentaire au moment de la rédaction.

### 1.1 `device_pairing_codes` — migration 029

Colonnes :
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` ;
- `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` ;
- `store_id uuid NOT NULL`, `pos_profile_id uuid` ;
- `code_hash text NOT NULL UNIQUE` ;
- `created_by uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()` ;
- `expires_at timestamptz NOT NULL`, `used_at timestamptz`.

Contraintes : hash non vide, expiration postérieure à la création, date d'utilisation non antérieure à la création. Index : `(tenant_id, expires_at)` et `(tenant_id, store_id)`.

La migration 030 fournit `redeem_device_pairing_code(text)`, fonction SQL SECURITY DEFINER avec `search_path` fixé, qui consomme un code non expiré et non utilisé par un UPDATE conditionnel. L'accès PUBLIC est révoqué et EXECUTE est accordé à `sync_app`. Le code de service calcule le SHA-256 du code normalisé et consomme le code puis insère le terminal dans la même transaction.

### 1.2 `devices` — migration 030

Colonnes actuelles :
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` ;
- `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` ;
- `store_id uuid NOT NULL`, `pos_profile_id uuid` ;
- `name varchar(120) NOT NULL`, `fingerprint varchar(255) NOT NULL` ;
- `hardware_info jsonb NOT NULL` ;
- `is_active boolean NOT NULL DEFAULT true` ;
- `created_at timestamptz NOT NULL DEFAULT now()`.

Contraintes : nom et fingerprint non vides, hardware_info de type objet, unicité `(tenant_id, fingerprint)`. Index : `(tenant_id, store_id)` et `(tenant_id, is_active)`. RLS et FORCE RLS sont activés ; la policy compare `tenant_id` à `app.current_tenant_id`. Le rôle `sync_app` a SELECT, INSERT et UPDATE.

Le DTO actuel demande `activationCode`, `deviceName`, `hardwareInfo`. Le contrôleur reçoit aussi `X-Device-Fingerprint`. Le service crée le terminal avec `isActive: true` et retourne `status: 'enrolled'`. Cette valeur de réponse signifie seulement que l'enregistrement a été créé ; elle ne signifie pas que le terminal a été approuvé. Aucun credential cryptographique de terminal n'est enregistré par ce flux.

**Conséquence :** `is_active` ne permet pas, à lui seul, de distinguer un terminal en attente, approuvé, suspendu ou révoqué. Il ne faut pas le détourner implicitement pour exprimer ces états.

## 2. Modèle de données cible

Le modèle suivant est recommandé pour permettre rotation de clés, audit et révocation sans transformer la table métier `devices` en magasin de secrets.

### 2.1 Évolution additive de `devices`

Ajouter, dans une migration distincte :
- `approval_status` : statut serveur contrôlé ;
- `approval_requested_at timestamptz` ;
- `approved_at timestamptz`, `approved_by uuid` ;
- `rejected_at timestamptz`, `rejected_by uuid`, `rejection_reason text` ;
- `revoked_at timestamptz`, `revoked_by uuid`, `revocation_reason text` ;
- `suspended_at timestamptz`, `suspended_by uuid`, `suspension_reason text` ;
- `last_seen_at timestamptz` ;
- `updated_at timestamptz` avec valeur initiale cohérente.

Valeurs recommandées pour `approval_status` : `pending_approval`, `approved`, `rejected`, `suspended`, `revoked`. Une contrainte CHECK ou un type enum doit empêcher les valeurs inconnues. Les transitions doivent être contrôlées par le service, pas par une simple mise à jour générique.

Conserver `is_active` pendant la période de compatibilité. Définir sa sémantique transitoire comme un indicateur historique/technique d'activation, et non comme une autorisation suffisante. À terme, le contrôle d'accès se fonde sur `approval_status` et les credentials valides ; la suppression de `is_active` ne se fera que dans une migration ultérieure après inventaire de tous ses usages.

### 2.2 Table séparée `device_credentials`

Créer une table séparée pour les credentials publics. Proposition de colonnes :
- `id uuid PRIMARY KEY` ;
- `tenant_id uuid NOT NULL` et `device_id uuid NOT NULL` ;
- `public_jwk jsonb NOT NULL` (clé publique uniquement) ;
- `jwk_thumbprint text NOT NULL` ;
- `algorithm text NOT NULL` (allowlist de l'algorithme retenu) ;
- `key_version integer NOT NULL` ;
- `status text NOT NULL` : `active`, `rotated`, `revoked` ;
- `created_at timestamptz NOT NULL`, `activated_at timestamptz` ;
- `rotated_at timestamptz`, `revoked_at timestamptz` ;
- `created_by uuid` si l'action est initiée par un acteur administratif.

Contraintes et index :
- FK composite ou contrainte équivalente garantissant que credential et device appartiennent au même tenant ;
- unicité du thumbprint dans le périmètre défini par la politique de sécurité (recommandation : globale) ;
- unicité de `(device_id, key_version)` ;
- index sur `(tenant_id, device_id)` ;
- index unique partiel garantissant au plus un credential `active` par terminal ;
- CHECK sur statut, version positive et forme JSON/JWK minimale.

RLS doit être activée et forcée, avec une policy tenant-scoped analogue à `devices`. Les opérations d'administration inter-tenant doivent passer par des services/transactions étroits et explicitement autorisés, jamais par un contournement RLS générique.

La clé privée n'est jamais stockée dans PostgreSQL, dans les logs, ni envoyée à l'API. La base ne contient que la clé publique/JWK et ses métadonnées.

### 2.3 Journal append-only `device_approval_events`

Créer un journal d'audit append-only distinct, avec au minimum :
- identifiant, tenant, device ;
- type d'événement (`enrolled`, `approval_requested`, `approved`, `rejected`, `suspended`, `reactivated`, `revoked`, `credential_added`, `credential_rotated`, `credential_revoked`) ;
- acteur (type et identifiant), date serveur ;
- motif/code de décision et métadonnées non sensibles ;
- identifiant de corrélation/requête.

Interdire UPDATE/DELETE au rôle applicatif courant. Les événements sont écrits dans la même transaction que la transition d'état. Ne jamais journaliser code d'activation, jeton d'accès, clé privée, preuve DPoP brute ou données personnelles matérielles non nécessaires.

## 3. Stratégie de migration et compatibilité

La migration doit être additive, déployée avant le code qui dépend des nouvelles colonnes.

1. Ajouter les colonnes nullable ou avec un défaut sûr, contraintes validées après backfill.
2. Ajouter `approval_status` sans convertir automatiquement les terminaux historiques en `approved`.
3. Backfill prudent : les lignes existantes deviennent `pending_approval` tant qu'une preuve administrative fiable d'approbation n'existe pas. `is_active=true` n'est pas une preuve.
4. Inscrire un événement d'audit de migration pour chaque ligne classée, avec origine `legacy_migration`.
5. Créer `device_credentials` vide ; aucun fingerprint ne doit être transformé en clé ou credential.
6. Déployer l'API en mode compatibilité contrôlée : routes anciennes identifiées, aucune synchronisation silencieusement considérée comme approuvée.
7. Enrôler/valider les terminaux existants par une procédure explicite de ré-authentification et d'approbation.
8. Activer le contrôle strict sur les routes sync après mesure de couverture et validation opérationnelle.

**Point de bascule :** la synchronisation doit refuser un terminal sans statut approuvé et credential valide dès que le mode strict est activé. Une période de compatibilité ne doit pas créer de voie de contournement permanente.

Rollback : le code applicatif peut être ramené à la version précédente tant que les nouvelles colonnes/tables restent additives. Ne pas supprimer les nouvelles données ni inverser les décisions d'approbation. Toute désactivation temporaire du guard strict doit être une mesure d'urgence tracée, limitée dans le temps et approuvée ; la recommandation est de ne pas prévoir de bypass silencieux.

## 4. Contrats API proposés

Les chemins ci-dessous sont des propositions. Ils ne sont pas déclarés existants et devront être alignés sur le versionnement NestJS/OpenAPI déjà en place.

### 4.1 Demande d'enrôlement

`POST /api/v1/devices/enroll`

Requête : code à usage unique, nom du terminal, métadonnées minimales, JWK publique et algorithme/version supportés. Le serveur valide le format de la clé, calcule lui-même le thumbprint et consomme le code atomiquement.

Réponse indicative : `deviceId`, `tenantId`, `approvalStatus: "pending_approval"`, `credentialId`, `nextAction`. La réponse ne doit jamais annoncer `approved` à la suite de la seule consommation du code.

### 4.2 Statut du terminal

`GET /api/v1/devices/me/status`

Exiger un jeton agent valide et une preuve de possession de la clé du terminal. Réponse indicative :
- `deviceId`, `tenantId`, `approvalStatus` ;
- `credentialVersion`, `serverTime` ;
- `approvalLease` signé si et seulement si une politique de fonctionnement hors ligne a été définie.

La réponse doit être liée au credential qui a signé la requête. Un statut provenant d'un autre terminal ne doit pas pouvoir être rejoué.

### 4.3 Décisions administratives

Routes proposées :
- `POST /api/v1/admin/devices/:deviceId/approve` ;
- `POST /api/v1/admin/devices/:deviceId/reject` ;
- `POST /api/v1/admin/devices/:deviceId/suspend` ;
- `POST /api/v1/admin/devices/:deviceId/reactivate` ;
- `POST /api/v1/admin/devices/:deviceId/revoke`.

Chaque mutation exige rôle explicite, tenant scope, motif adapté, contrôle de transition et événement append-only. Les réponses incluent l'état final et un identifiant d'audit. Le serveur doit vérifier que l'acteur est habilité sur le tenant concerné.

### 4.4 Rotation de clé

`POST /api/v1/devices/me/credentials/rotate`

La nouvelle clé est créée localement et prouvée par possession. Préférer une transition à deux phases : ajout du nouveau credential, validation, activation atomique, puis invalidation de l'ancien. Prévoir une récupération administrative en cas de perte de clé ; ne pas accepter une nouvelle clé sur la seule base du fingerprint.

## 5. Permissions et séparation des responsabilités

Permissions recommandées, tenant-scoped :
- `devices:read` : consulter les terminaux du tenant ;
- `devices:enroll` : émettre/gérer les autorisations d'activation selon politique ;
- `devices:approve` : approuver un terminal ;
- `devices:reject` : refuser un terminal ;
- `devices:suspend` : suspendre temporairement ;
- `devices:reactivate` : réactiver ;
- `devices:revoke` : révoquer définitivement ;
- `devices:credentials:rotate` : autoriser/récupérer une rotation.

Ne pas accorder ces droits à un agent POS ordinaire. L'approbation doit être réservée à un rôle de gestion explicitement autorisé. Lorsque l'organisation le permet, l'acteur qui approuve doit être distinct de celui qui a demandé l'enrôlement. Toute exception doit être explicite et auditée.

L'identifiant d'acteur doit provenir du contexte authentifié validé par le serveur, jamais d'un champ `approvedBy` librement fourni par le client.

## 6. Authentification desktop et preuve de possession

### 6.1 Authentification de l'agent

Pour un client Electron public, privilégier OAuth 2.0 Authorization Code avec PKCE, ouverture du navigateur système et retour par URI de redirection sécurisée ou mécanisme localhost strictement borné. Aucun secret client ne doit être embarqué dans le binaire. Ne pas demander à l'utilisateur de coller un JWT brut dans l'interface en tant que parcours normal de production.

Les tokens agent sont validés par l'API avec JWKS et paramètres obligatoires : issuer, audience, algorithmes autorisés, expiration et claims requis. En production, le mode secret partagé HS256 ne doit pas être le mécanisme nominal pour les sessions utilisateurs/terminaux. Une migration vers IdP doit être planifiée et vérifiée avant d'exiger ce flux.

### 6.2 Credential terminal

Au premier enrôlement, Electron génère une paire de clés asymétriques. La clé privée reste locale et protégée via le stockage sécurisé du système d'exploitation ; la clé publique est envoyée à l'API. Sur Windows, tester le comportement réel de `safeStorage` et du profil utilisateur, notamment après redémarrage, changement de session, restauration et réinstallation.

Recommandation à confirmer par prototype : ECDSA P-256 avec SHA-256 et représentation JWK, sous réserve de compatibilité de la bibliothèque JOSE et du runtime Electron retenus. Ne pas figer l'algorithme avant tests interopérabilité et revue cryptographique.

### 6.3 DPoP

Utiliser le standard DPoP (RFC 9449) et une bibliothèque JOSE maintenue. Ne pas créer un protocole maison. Le middleware/guard vérifie la signature, le lien au jeton, la méthode, l'URI, l'horodatage, le thumbprint et les paramètres requis par le profil DPoP choisi.

La détection de rejeu exige un stockage partagé entre toutes les instances API, typiquement Redis, avec TTL aligné sur la fenêtre d'acceptation. Une mémoire locale par instance n'est pas suffisante en production multi-instance. Si le stockage anti-rejeu est indisponible, refuser la requête protégée (fail closed) et produire une erreur opérationnelle non sensible.

## 7. Contrôle obligatoire avant synchronisation

Ordre logique recommandé dans un guard/service commun avant tout handler sync :
1. valider cryptographiquement le jeton agent ;
2. valider issuer, audience, expiration et claims ;
3. vérifier la preuve DPoP et l'anti-rejeu ;
4. résoudre le credential enregistré par thumbprint et le lier au `deviceId` ;
5. vérifier que device, credential, agent et tenant sont cohérents ;
6. vérifier `approval_status = approved`, credential actif et absence de révocation/suspension ;
7. vérifier les permissions métier de l'agent ;
8. établir le contexte tenant RLS pour la transaction.

Ne pas faire confiance à un `deviceId` fourni uniquement dans le body. Le device doit être déterminé à partir de la preuve cryptographique validée et du credential enregistré.

Toute incohérence, statut inconnu, registre indisponible, échec de vérification cryptographique ou anti-rejeu indisponible bloque l'opération protégée. Les contrôles doivent s'appliquer uniformément aux endpoints de pull, push, POS et aux éventuelles routes de reprise.

## 8. Hors ligne, bail d'approbation et révocation

Une révocation ne peut pas être connue instantanément par un terminal déconnecté. La politique produit doit donc définir :
- les opérations locales autorisées avant approbation ;
- les opérations autorisées après la dernière approbation valide ;
- la durée maximale du bail hors ligne ;
- les opérations qui exigent une vérification en ligne ;
- le traitement des ventes locales créées pendant une période qui précède la découverte d'une révocation.

Recommandation : utiliser un bail signé par le serveur, lié au device, tenant, credential version et date d'expiration. Le client vérifie sa signature localement et ne peut pas prolonger sa durée. À expiration, bloquer les opérations sensibles nécessitant une approbation fraîche, tout en préservant les données locales et l'outbox. La durée exacte est une décision de risque métier, à définir avant implémentation.

Une révocation bloque les nouvelles requêtes serveur et invalide les credentials selon la politique retenue. Elle ne supprime jamais automatiquement SQLite, les ventes locales ou l'outbox. La résolution des opérations locales après révocation est un processus métier audité, pas une purge technique.

## 9. Matrice de tests et critères d'acceptation

### Base de données et migrations
- migration sur base vide et base représentative de production ;
- lignes historiques actives et inactives backfillées sans approbation implicite ;
- RLS/FORCE RLS sur chaque nouvelle table ;
- credential d'un tenant inaccessible depuis un autre tenant ;
- unicité d'un seul credential actif par terminal ;
- transitions d'état et événements écrits atomiquement ;
- rôle applicatif incapable de modifier/supprimer le journal append-only.

### API et sécurité
- code expiré, consommé ou concurrent : un seul enrôlement effectif ;
- clé publique invalide, algorithme interdit ou thumbprint falsifié refusés ;
- terminal pending/rejected/suspended/revoked refusé sur toutes les routes sync ;
- jeton agent valide sans DPoP refusé ;
- DPoP d'un autre terminal, d'une autre méthode/URI ou d'un autre jeton refusé ;
- preuve rejouée rejetée entre deux instances API ;
- agent d'un autre tenant et agent sans permission refusés ;
- statut inconnu ou dépendance de sécurité indisponible : refus par défaut ;
- approbation et révocation auditées avec acteur serveur authentifié ;
- rotation concurrente et perte de clé gérées sans accepter deux clés actives.

### Electron/Windows et bout en bout
- clé privée jamais exportée vers l'API, les logs ou un fichier en clair ;
- génération idempotente, stockage chiffré, redémarrage et restauration ;
- perte/indisponibilité de clé : récupération contrôlée, pas de ré-enrôlement silencieux ;
- aucune sync avant approbation ;
- approbation puis premier pull/push avec agent et device distinctement authentifiés ;
- panne réseau à chaque étape : état récupérable, aucune fausse approbation ;
- révocation découverte : arrêt sync et conservation SQLite/outbox ;
- validation sur installation Windows propre et profils Windows distincts.

### Go/No-Go

**GO** seulement si :
- la signature agent et la preuve de possession du terminal sont toutes deux vérifiées côté API ;
- chaque route de sync vérifie le statut du terminal et le tenant ;
- les décisions administratives sont tenant-scoped et auditées ;
- anti-rejeu est partagé entre instances ;
- migrations et backfill sont testés sur données legacy ;
- Electron ne synchronise jamais avant une approbation vérifiée ;
- le comportement hors ligne et la récupération sont documentés et testés.

**NO-GO** si un JWT agent seul permet de synchroniser sans terminal approuvé, si un client peut déclarer son propre statut, si le fingerprint est traité comme secret, si une panne de sécurité est contournée silencieusement ou si une migration peut attribuer une entreprise ou une approbation incorrecte.

## 10. Décisions restant à valider avant le code

1. Fournisseur IdP, issuer, audience et configuration OAuth desktop.
2. Bibliothèque JOSE, profil DPoP et algorithme final après prototype Windows.
3. Modèle exact des rôles d'administration et séparation demandeur/approbateur.
4. Durée et contenu du bail hors ligne, et opérations métier autorisées.
5. Politique de transition des terminaux historiques et fenêtre de ré-enrôlement.
6. Politique de rotation, récupération et remplacement des clés.
7. Disponibilité Redis et stratégie opérationnelle en cas de panne.
8. Politique de rétention du journal d'audit et gestion des données personnelles.

**Conclusion :** cette spécification fixe une cible testable et une migration prudente. Elle ne modifie pas le code, les migrations, la PR #63 ni `main`. L'implémentation devra commencer sur une branche fonctionnelle dédiée après revue de cette conception.
