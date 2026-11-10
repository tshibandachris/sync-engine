# Matrice de correspondance — identité et approbation des terminaux

> **Statut :** audit statique du dépôt et plan de correction.
> **Référence code :** `main` au commit `b68aa268a6a2cca92f1a86d0472b16c0a5725748`.
> **Changement séparé en attente :** PR #63, branche `fix/electron-local-tenant-binding`, head `ce581d30bc035aa796380c6dc27721f7e22eed33`.
> **Branche de ce document :** `docs/device-activation-contract`.
> **Limite :** lecture du code et des tests présents ; aucun test n'a été exécuté pendant cet audit. Les tests cités comme existants sont ceux identifiés dans le dépôt. Les tests de correction sont des exigences futures.

## 1. Synthèse exécutive

Le dépôt possède déjà des fondations utiles : code d'appairage à usage unique consommé atomiquement, registre de terminaux avec RLS, vérification JWT côté API, stockage chiffré du jeton côté Electron, synchronisation locale avec outbox et protection contre le changement silencieux de tenant proposée dans la PR #63.

Cependant, le parcours actuel ne relie pas ces éléments en une identité de terminal approuvée de bout en bout.

**Écart central :** l'API enregistre un terminal à partir d'un code d'activation, tandis que le client Electron devient localement `ready` après avoir stocké un JWT collé par l'utilisateur. La synchronisation est ensuite autorisée par le seul `JwtAuthGuard`, qui vérifie l'identité agent/tenant mais ne vérifie pas l'identité cryptographique ni l'état d'approbation d'un terminal enregistré.

Le statut `ready` est donc un état local de disponibilité du jeton, pas une preuve d'approbation serveur.

### État par domaine

| Domaine | État observé sur `main` | Évaluation |
|---|---|---|
| Code d'activation à usage unique | Implémenté, transactionnel | Solide, à compléter par l'approbation |
| Registre `devices` et RLS | Implémenté | Base utile, modèle d'état incomplet |
| Liaison SQLite ↔ tenant | Présente dans la PR #63, pas dans `main` de référence | En attente de décision/merge |
| Stockage sécurisé du jeton | Implémenté avec Electron safeStorage | Bonne base, mais le secret reste un JWT collé |
| Authentification agent par JWKS | Implémentée | Correcte si config complète |
| Authentification production par IdP | Le code le permet, Compose prod active shared-secret | Écart de configuration P0 |
| Credential cryptographique du terminal | Absent | P0 |
| Approbation/refus/révocation serveur | Absent dans le flux examiné | P0 |
| Contrôle terminal sur routes sync | Absent | P0 |
| DPoP / anti-rejeu de preuve terminal | Absent | P0 |
| Audit des décisions terminal | Absent dans le flux examiné | P1 |
| Rate limit d'enrôlement | Implémenté, Redis optionnel | À rendre partagé en production |

## 2. Matrice détaillée

Légende :
- **Présent** : fonctionnalité visible dans le code de référence.
- **Partiel** : une partie du besoin est couverte, mais le contrat cible n'est pas satisfait.
- **Absent** : aucun mécanisme correspondant n'a été identifié dans les chemins et modules examinés.
- **En attente PR #63** : changement disponible dans une PR ouverte, pas dans `main`.

| ID / priorité | Composant cible | État réel et preuve dans le dépôt | Écart précis | Fichiers concernés | Correction attendue | Tests d'acceptation |
|---|---|---|---|---|---|---|
| A01 — P0 | Enrôlement serveur par code unique | **Présent.** `POST /api/v1/devices/enroll`; DTO contrôlé ; SHA-256 du code ; fonction SQL de consommation conditionnelle ; insertion dans la même transaction. | Le terminal est créé avec `is_active=true` et la réponse dit `status: enrolled`. Aucun état `pending_approval` n'est persisté. | `src/device-enrollment.controller.ts`, `src/device-enrollment.dto.ts`, `src/device-enrollment.service.ts`, `migrations/029_create_device_pairing_codes.sql`, `migrations/030_create_enrolled_devices.sql`. | Conserver l'atomicité. Faire évoluer la réponse vers `approvalStatus: pending_approval`; l'enrôlement ne doit pas approuver le terminal. Ajouter clé publique/JWK au DTO après validation cryptographique et persister son thumbprint. | Code expiré/usé refusé ; deux requêtes concurrentes : une seule réussit ; rollback du code si création/credential échoue ; nouveau terminal reste pending ; clé publique mal formée/algorithme interdit refusés. |
| A02 — P0 | Statuts serveur du terminal | **Partiel.** Table `devices` ne contient que `is_active` pour l'état. | Impossible de distinguer attente, approbation, refus, suspension et révocation. `is_active=true` est posé à la création et n'est pas une approbation. | `migrations/030_create_enrolled_devices.sql`, `src/schema.ts`, `src/device-enrollment.service.ts`. | Migration additive : `approval_status` avec CHECK/enum ; dates et acteurs de décision ; transitions centralisées. Garder `is_active` en compatibilité sans le traiter comme autorisation. | Migration base vide et base legacy ; valeurs invalides rejetées ; transitions permises/interdites ; aucune ligne historique approuvée sur le seul critère `is_active=true`. |
| A03 — P0 | Credential cryptographique terminal | **Absent.** `fingerprint` vient de `X-Device-Fingerprint` et est stocké comme texte. | Fingerprint client-déclaré, mutable et copiable ; pas de paire de clés, JWK, thumbprint ou preuve de possession. | `src/device-enrollment.dto.ts`, `src/device-enrollment.service.ts`, `migrations/030_create_enrolled_devices.sql`, nouveau `device_credentials`, Electron auth. | Générer une paire de clés dans Electron ; ne transmettre que la clé publique ; persister les credentials publics dans une table séparée ; lier le thumbprint au device et au tenant. | Clé générée une fois ; clé privée absente des requêtes/logs/fichiers en clair ; JWK/thumbprint vérifiés côté serveur ; credential d'un autre terminal refusé ; tenant croisé refusé. |
| A04 — P0 | Approbation administrative | **Absent dans le flux examiné.** Aucun contrôleur/service d'approbation terminal ni endpoint d'état n'a été identifié. | N'importe quel terminal créé par code reste `is_active=true` ; aucune décision admin distincte ni trace d'acteur. | Nouveaux contrôleurs/services/DTO ; `src/app.module.ts` ; migrations d'état et d'audit. | Ajouter permissions tenant-scoped approve/reject/suspend/reactivate/revoke ; vérifier l'acteur côté serveur ; écrire l'événement d'audit dans la même transaction. | Agent POS sans permission refusé ; admin du mauvais tenant refusé ; acteur absent/invalide refusé ; chaque décision produit un événement append-only ; transitions incohérentes rejetées. |
| A05 — P0 | Contrôle terminal sur toutes les routes sync | **Absent.** `SyncController` utilise `JwtAuthGuard` au niveau du contrôleur ; le guard définit `agentId`, `tenantId`, permissions et services. Aucun `deviceId`/credential/status n'est validé. | Un JWT agent/tenant accepté peut appeler pull/push/conflits sans prouver que le terminal est enregistré et approuvé. | `src/sync.controller.ts`, `src/jwt.guard.ts`, nouveau guard/service device-auth ; routes additionnelles à inventorier. | Ajouter une vérification commune après JWT et avant les handlers : preuve terminal, credential actif, statut approved, tenant égal, agent autorisé. Appliquer à pull, push, conflits, POS, pièces jointes et toute route protégée qui représente une session de terminal. | Token seul refusé ; terminal pending/rejected/suspended/revoked refusé ; tenant mismatch refusé ; credential inconnu refusé ; routes sync et POS couvertes par tests HTTP d'intégration. |
| A06 — P0 | Authentification agent IdP en production | **Partiel / configuration non conforme à la cible.** Le guard prend en charge JWKS et vérifie la signature avec `jose`. Mais `docker-compose.prod.yml` force `AUTH_ALLOW_SHARED_SECRET=true`, et ne configure pas JWKS. | La production déclarée utilise un secret partagé capable de signer des jetons pour tout tenant ; pas le flux IdP/JWKS prévu pour l'architecture cible. | `src/idp.config.ts`, `src/idp-token.ts`, `src/jwt.guard.ts`, `src/boot-guards.ts`, `docker-compose.prod.yml`, `.env.prod.example`, `scripts/mint-token.mjs`. | Choisir et configurer un IdP réel ; fournir JWKS_URL, JWT_AUDIENCE et JWT_ISSUER ; rendre issuer obligatoire en production ; retirer shared-secret du profil de déploiement cible après migration contrôlée. | Boot refuse JWKS sans audience/issuer ; issuer/audience erronés rejetés ; rotation JWKS ; signature/exp/nbf invalides rejetés ; test d'intégration contre un JWKS local de test. |
| A07 — P1 | Flux OAuth desktop | **Absent comme parcours Electron.** L'UI demande de coller un JWT ; le renderer transmet `{token}` à l'IPC. | Pas de navigateur système, Authorization Code + PKCE, ni lien vérifié entre session agent et terminal. | `electron-app/electron/renderer/renderer.js`, `electron-app/electron/preload.cjs`, `electron-app/electron/main.cjs`, nouveaux modules auth/IPC. | Remplacer le collage JWT par Authorization Code + PKCE via navigateur système et redirection contrôlée ; aucun secret client embarqué. Lier l'agent authentifié au terminal présenté à l'API. | État OAuth interrompu/repris ; state/nonce/PKCE vérifiés ; redirect invalide refusée ; aucun token dans URL/logs ; aucun secret client dans bundle ; session d'un agent différent refusée selon politique. |
| A08 — P0 | État Electron aligné sur approbation serveur | **Partiel et trompeur.** `initializeDeviceToken()` met `authState='ready'` si un JWT est présent ; IPC le met aussi à ready après écriture/relecture chiffrée. | `ready` signifie « jeton local stocké », non « terminal approuvé ». Le client peut lancer `doSync()` immédiatement après cette transition. | `electron-app/electron/main.cjs`, `electron-app/electron/renderer/renderer.js`. | Séparer les états locaux : token disponible, tenant lié, activation pending, approbation confirmée, retry, rejected/revoked. Seul un statut serveur authentifié et lié au credential permet sync. | Aucun pull/push avant approved ; timeout conserve état retry ; 5xx n'est pas refus ; réponse statut d'un autre device rejetée ; redémarrage restaure l'état sans le promouvoir à approved. |
| A09 — P1 | Liaison SQLite ↔ tenant | **En attente PR #63.** La branche PR ajoute `device_binding`, extraction de `tenantId`, blocage mismatch et refus d'affecter un tenant à une base legacy avec données sans migration explicite. | Cette protection n'est pas présente sur `main` au commit audité. La migration legacy autorisée doit rester encadrée et ne valide pas la signature du JWT. | `electron-app/electron/db/client.cjs`, `electron-app/electron/auth/device-enrollment.cjs`, `electron-app/electron/main.cjs`; PR #63. | Garder la liaison locale comme garde de continuité, indépendante de l'approbation serveur. Revoir et valider la PR #63 séparément ; ne pas considérer son merge comme résolution de l'identité cryptographique. | Base vide liée ; restart persistant ; mismatch bloque sans effacer ; base legacy avec données non liée refusée ; migration legacy explicite conserve données ; claim local non présenté comme validation cryptographique. |
| A10 — P1 | Stockage sécurisé credential terminal | **Partiel.** `DeviceTokenStore` utilise Electron `safeStorage`, refuse backend plaintext/unknown et refuse fallback en clair. | Il protège un JWT collé, pas une clé privée terminal dédiée. Le modèle ne couvre pas génération/rotation/perte de clé. | `electron-app/electron/auth/device-token-store.cjs`, `electron-app/electron/main.cjs`, nouveau `device-key-store.cjs`. | Réutiliser le principe safeStorage pour une clé privée ou un secret de coffre, avec format/version, permissions, rotation et récupération contrôlée. Vérifier le backend OS réel sur Windows. | Backend OS sécurisé requis ; corruption/refus sans fallback ; redémarrage ; profil Windows différent ; perte de clé ; migration de version ; clé privée jamais exportée. |
| A11 — P0 | DPoP et anti-rejeu | **Absent.** Le client ajoute seulement `Authorization: Bearer`; l'API ne valide aucune preuve de possession terminal. | Un bearer token copié reste utilisable tant qu'il est valide ; aucun `jti`/empreinte de preuve consommé côté serveur. | `electron-app/electron/sync/api-client.cjs`, nouveau module DPoP ; `src/jwt.guard.ts` ou guard dédié ; configuration Redis. | Implémenter DPoP standard via JOSE ; lier preuve à méthode/URI/token/device ; stocker les identifiants de preuve dans Redis partagé avec TTL ; refuser si le contrôle anti-rejeu est indisponible. | Signature invalide, htm/htu erronés, token binding incorrect, preuve expirée et rejeu refusés ; même rejeu sur deux instances API refusé ; panne Redis = fail closed. |
| A12 — P1 | Rate limit activation partagé | **Partiel.** `src/device-enrollment.throttle.ts` possède une implémentation Redis atomique et un fallback mémoire si `REDIS_URL` absent. | Le Compose production consulté ne fournit pas `REDIS_URL`; le fallback mémoire n'est pas partagé entre plusieurs instances. | `src/device-enrollment.throttle.ts`, `src/app.module.ts`, `docker-compose.prod.yml`, `.env.prod.example`. | Rendre Redis obligatoire pour l'enrôlement exposé en production ; boot fail si stockage partagé absent ; limiter aussi par IP et code/identifiant avec stratégie anti-abus sans confiance aveugle dans fingerprint. | Deux instances partagent le compteur ; limites minute/heure cohérentes ; Redis absent en prod empêche le boot ; panne Redis refuse l'enrôlement plutôt que de retomber en mémoire. |
| A13 — P1 | Émission et gestion des codes | **Partiel.** Migration et fonction de consommation présentes ; aucun endpoint/service d'émission administrative identifié dans les fichiers contrôleur/service examinés. | Le flux de création, expiration, révocation et audit des codes n'est pas documenté comme parcours produit complet. | Nouveau service/controller administratif ; `migrations/029_create_device_pairing_codes.sql` ; `src/app.module.ts`. | Créer une émission admin autorisée et tenant-scoped ; générer un secret aléatoire robuste, ne stocker que son hash ; retourner le code une seule fois ; durée limitée ; journaliser émission/révocation sans stocker le secret. | Code créé pour bon tenant/store ; utilisateur non autorisé refusé ; hash seul en base ; expiration ; révocation ; consommation unique ; aucun secret dans logs. |
| A14 — P1 | Audit append-only des terminaux | **Partiel.** Le dépôt possède un mécanisme d'observabilité des requêtes sync, mais pas de journal de décisions d'approbation terminal identifié. | Les décisions admin et changements de credential ne sont pas retraçables comme événements métier dédiés. | `src/observability/sync-log.interceptor.ts`, `src/observability/sync-log.service.ts`, nouvelles migrations et services device. | Ajouter `device_approval_events`, append-only, même transaction que transition ; acteur, tenant, device, motif, corrélation ; interdire UPDATE/DELETE au rôle applicatif. | Événement atomique avec transition ; rôle ne peut ni modifier ni supprimer ; aucune donnée secrète ; audit couvre approve/reject/suspend/reactivate/revoke/rotation. |
| A15 — P1 | API statut et bail hors ligne | **Absent.** Pas de route statut device/lease identifiée dans le contrôleur d'enrôlement. | Electron ne peut pas demander une décision serveur vérifiable et ne peut pas distinguer attente, révocation ou indisponibilité réseau. | Nouveau `device-status.controller.ts`/service/DTO ; `electron-app/electron/main.cjs`; client API. | Ajouter endpoint de statut lié au credential et réponse signée/cryptographiquement authentifiée ; définir ensuite un bail offline lié au tenant/device/credential et une durée métier. | Statut d'un autre device rejeté ; réponse altérée rejetée ; pending vs rejected vs revoked distingués ; timeout retry ; bail expiré interdit les opérations sensibles mais conserve SQLite/outbox. |
| A16 — P1 | Permissions d'administration | **Partiel.** JWT guard extrait `permissions` ou `scope`, mais aucune permission de gestion des terminaux n'est consommée dans un contrôleur identifié. | Claims présents ne suffisent pas : aucune vérification explicite de permission pour approuver ou révoquer un device. | `src/idp-token.ts`, `src/jwt.guard.ts`, nouveau guard/decorator/authorization service, contrôleurs admin. | Définir permissions `devices:read/enroll/approve/reject/suspend/reactivate/revoke/credentials:rotate` et vérifier tenant + acteur côté API. | Permission manquante/inter-tenant refusée ; rôle POS ne peut approuver ; acteur fourni dans body ignoré ; approbation auditée avec actor du contexte JWT. |
| A17 — P2 | Inventaire des routes protégées | **Partiel.** `SyncController` applique JWT au contrôleur ; les autres contrôleurs ont leurs propres protections à vérifier. | Ajouter le guard device seulement à SyncController pourrait laisser une route POS, pièce jointe ou autre route exposée hors du contrôle terminal. | `src/app.module.ts`, `src/*controller.ts`, tests HTTP. | Faire l'inventaire exhaustif de toutes les routes qui manipulent données tenant ou sync ; appliquer un guard commun là où le contexte terminal est obligatoire ; documenter explicitement les exceptions. | Test de couverture par route : sans agent 401 ; sans preuve device 401/403 ; pending/revoked 403 ; exception publique uniquement si déclarée. |
| A18 — P2 | Observabilité et réponse d'erreur | **Partiel.** Sync logs capturent opération/statut/agent/tenant et métriques ; Electron affiche une erreur générique de sync en attente. | Pas de codes d'état d'activation normalisés ni d'indicateurs spécifiques aux refus de device/DPoP/approbation. | `src/observability/*`, `electron-app/electron/main.cjs`, `electron-app/electron/renderer/renderer.js`. | Ajouter codes d'erreur non sensibles et métriques pour pending/rejected/revoked/DPoP replay/Redis unavailable ; ne jamais journaliser token, code ou preuve brute. | Erreurs stables côté API/UI ; aucun secret dans logs ; métriques incrémentées ; panne réseau différenciée d'un refus administratif. |

## 3. Couverture de tests déjà identifiée

Les fichiers de test suivants existent sur la référence auditée :

| Fichier de test | Ce qu'il couvre déjà | Ce qu'il ne prouve pas |
|---|---|---|
| `test/device-enrollment.atomic.spec.ts` | Usage unique concurrent ; rollback de consommation si insertion échoue ; fingerprint déjà enrôlé. | Approbation, clé publique, credential, statut, contrôle sync. |
| `test/device-enrollment.throttle.e2e.spec.ts` | Limite HTTP d'enrôlement ; 429 après cinq tentatives ; sync garde son 401 JWT. | Compteur Redis partagé multi-instance ; fail-closed en production ; anti-abus distribué. |
| `test/idp-token.spec.ts` | Signature JWKS, expiration, audience, issuer lorsqu'il est fourni, sub/tenant UUID, permissions/scope. | Issuer obligatoire au boot prod ; device binding ; DPoP. |
| `test/boot-guards.spec.ts` | Stratégies de boot, JWT secret fort, JWKS/audience requis ou shared-secret explicitement activé. | Configuration de production réelle avec IdP ; issuer obligatoire ; Redis obligatoire pour sécurité terminal. |
| `test/auth.http.spec.ts` | Route de token de développement désactivable. | OAuth desktop et liaison agent/terminal. |
| `electron-app/test/device-enrollment.test.cjs` | Validation structurelle JWT, expiration et signature présente. | Validation cryptographique de la signature par Electron ; statut serveur. |
| `electron-app/test/device-token-store.test.cjs` | safeStorage, refus backend non sécurisé, corruption et absence de fallback plaintext. | Stockage d'une clé privée terminal, rotation et récupération. |
| `electron-app/test/tenant-binding.test.cjs` dans PR #63 | Binding tenant, mismatch, données legacy et conservation. | Présence sur main tant que PR #63 n'est pas intégrée ; approbation cryptographique. |
| `test/pos-multi-device.spec.ts` | Scénarios multi-terminaux POS sur le plan métier. | Authentification/approbation cryptographique du terminal HTTP. |

## 4. Ordre de correction recommandé

L'ordre est choisi pour éviter d'activer un guard qui rendrait le produit inutilisable avant que les parcours d'enrôlement et d'administration existent.

### Phase 0 — décisions et prérequis
1. Valider l'IdP et ses paramètres issuer/audience/JWKS.
2. Valider le protocole DPoP et la bibliothèque JOSE.
3. Fixer la politique offline (bail, opérations locales, traitement des ventes après révocation).
4. Définir rôles et processus d'approbation.

**Sortie attendue :** décisions d'architecture écrites et paramètres d'environnement connus.

### Phase 1 — fondation serveur additive
1. Migration `devices.approval_status` et métadonnées.
2. Tables `device_credentials` et `device_approval_events` avec RLS.
3. Backfill prudent des lignes historiques vers `pending_approval`, sauf preuve d'approbation documentée.
4. Services de transition et d'audit transactionnels.
5. Émission et révocation administrative des codes d'activation.

**Tests bloquants :** migrations legacy, RLS tenant, contraintes, transitions et journal append-only.

### Phase 2 — enrôlement cryptographique
1. Génération de clé dans Electron.
2. Envoi JWK publique pendant l'enrôlement.
3. Enregistrement du thumbprint et du credential côté serveur.
4. Retour explicite `pending_approval`.
5. Interface d'administration d'approbation.

**Tests bloquants :** clé, thumbprint, concurrence, tenant, code à usage unique et audit.

### Phase 3 — authentification agent et terminal
1. Flux OAuth desktop Authorization Code + PKCE.
2. DPoP côté Electron et vérification côté API.
3. Stockage partagé anti-rejeu (Redis) obligatoire en production.
4. Guard commun agent + device + tenant + permission.

**Tests bloquants :** signature, preuve liée à la requête, rejeu multi-instance, terminal pending/revoked, tenant croisé, Redis indisponible.

### Phase 4 — activation stricte et exploitation
1. API statut et éventuel bail offline.
2. Machine à états Electron ; remplacer le sens actuel de `ready`.
3. Contrôle sur toutes les routes protégées.
4. Migration des terminaux legacy, pilote terrain Windows et procédure de récupération.
5. Retirer shared-secret de la configuration production nominale.

**Tests bloquants :** aucune synchronisation avant approved ; aucune perte de données locale ; reprise réseau ; révocation ; installation Windows propre.

## 5. Découpage des livrables techniques

| Livrable | Fichiers à créer ou modifier (cibles) | Dépend de |
|---|---|---|
| Migration statut + audit + credentials | `migrations/031_device_approval_and_credentials.sql` (nom indicatif), `src/schema.ts` | Phase 0 |
| Service cycle de vie device | `src/device-management.service.ts`, DTO et tests associés | Migration |
| API admin et statut | `src/device-management.controller.ts`, `src/app.module.ts` | Service + permissions |
| Enrôlement JWK | `src/device-enrollment.dto.ts`, `src/device-enrollment.service.ts` | Table credential + crypto |
| OAuth desktop | nouveaux modules `electron-app/electron/auth/*`, `preload.cjs`, `main.cjs`, renderer | IdP |
| Clé privée locale | `electron-app/electron/auth/device-key-store.cjs` (nouveau) | Algorithme choisi |
| DPoP client | `electron-app/electron/auth/dpop.cjs`, `sync/api-client.cjs` | Clé privée + JOSE |
| Guard DPoP/device | `src/device-auth.guard.ts` (nouveau), `src/jwt.guard.ts` ou composition dédiée | Credential + Redis |
| Configuration prod | `docker-compose.prod.yml`, `.env.prod.example`, `src/boot-guards.ts` | IdP + Redis |
| UI cycle de vie | `electron-app/electron/renderer/renderer.js` et ressources UI | API statut |

Les noms de fichiers de cette table sont des propositions de découpage, pas des fichiers existants.

## 6. Points de vigilance avant implémentation

1. **Ne pas fusionner les notions :** JWT agent, identité terminal, approbation serveur et liaison SQLite sont quatre contrôles différents.
2. **Ne pas utiliser le fingerprint comme clé :** le conserver comme métadonnée d'inventaire seulement.
3. **Ne pas mettre le guard strict en production avant le parcours complet :** d'abord enrôlement, approbation, statut, DPoP, admin et tests.
4. **Ne pas approuver automatiquement les appareils historiques :** `is_active=true` ne constitue aucune preuve.
5. **Ne pas perdre les ventes hors ligne :** refus/révocation bloquent le réseau protégé, mais ne purgent ni SQLite ni outbox.
6. **Ne pas confondre la PR #63 avec l'approbation :** son binding local protège le tenant ; il ne prouve pas l'identité cryptographique du terminal.
7. **Ne pas déclarer les tests passés :** les tests cités sont des tests présents dans le dépôt ; cette matrice n'a pas exécuté de CI ni de tests locaux.

## 7. Conclusion de l'audit

**Décision actuelle : NO-GO pour considérer l'activation des terminaux comme sécurisée de bout en bout ou pour généraliser le déploiement sur la seule base du flux actuel.**

Les fondations d'enrôlement atomique, de RLS, de vérification JWT et de stockage sécurisé sont réutilisables. Les bloqueurs majeurs sont l'absence de credential cryptographique du terminal, l'absence d'approbation administrative, l'absence de contrôle device sur la synchronisation et le profil production shared-secret.

La correction doit se faire par phases additives et testées, sur une branche fonctionnelle distincte. La PR #63 doit être examinée selon son propre objectif et ne doit pas être fusionnée implicitement dans ce chantier.
