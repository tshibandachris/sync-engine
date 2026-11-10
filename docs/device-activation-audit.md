# Audit de conformité — activation et identité des terminaux

> **Date de l'audit :** 10 novembre 2026  
> **Périmètre du code :** branche `fix/electron-local-tenant-binding`, commit audité `ce581d30bc035aa796380c6dc27721f7e22eed33`  
> **Contrat de référence :** `docs/device-activation-contract.md`  
> **Nature :** audit statique des sources et tests présents ; aucun test ni déploiement n'a été exécuté dans le cadre de cette lecture.

## 1. Conclusion exécutive

Le dépôt contient des briques utiles : consommation atomique des codes d'appairage, création tenant-scoped d'un enregistrement de terminal, validation JWT côté API, stockage chiffré du jeton côté Electron et liaison SQLite au tenant.

Cependant, **le cycle d'identité et d'approbation du terminal n'est pas encore implémenté de bout en bout**.

Les deux flux restent disjoints :
1. l'API consomme un code et crée une ligne dans `devices`, sans délivrer de jeton ni exposer de décision d'approbation explicite ;
2. Electron accepte un JWT collé par l'opérateur, vérifie sa structure seulement, lie SQLite au tenant extrait et passe à `authState = ready`.

Le garde JWT de l'API authentifie actuellement un agent et un tenant, mais ne lie pas la requête à un `deviceId` enregistré et approuvé. La synchronisation n'établit donc pas l'approbation du terminal.

**Décision recommandée : NO-GO pour une généralisation de l'activation des terminaux**, jusqu'à correction des écarts P0 et validation des scénarios de bout en bout.

## 2. Matrice de conformité

| Exigence du contrat | État observé | Preuve dans le dépôt | Évaluation |
|---|---|---|---|
| Code d'activation à usage unique | Implémenté côté API | `src/device-enrollment.service.ts`, migration 030, test atomique | Conforme sur le mécanisme de consommation |
| Création serveur d'un terminal rattaché au tenant | Implémentée | `src/device-enrollment.service.ts`, table `devices` | Partielle : création, mais pas approbation |
| Délivrance/obtention du JWT après activation | Non intégrée au parcours d'enrôlement | `docs/device-enrollment.md`, `device-enrollment.service.ts` | Écart majeur |
| Appel du endpoint d'activation par Electron | Non observé | `main.cjs` et `renderer.js` | Écart majeur |
| Validation cryptographique du JWT par l'API | Implémentée en mode JWKS ou secret partagé | `src/jwt.guard.ts`, `src/idp-token.ts` | Partielle selon configuration |
| Validation de l'issuer en production | Non garantie | `boot-guards.ts`, `idp.config.ts`, `.env.example` | Écart |
| Identité du terminal dans le contexte authentifié | Non observée | `JwtAuthGuard` n'extrait que agent, tenant, permissions, services | Écart majeur |
| Vérification du statut du terminal à chaque sync | Non observée | `src/sync.controller.ts`, `src/jwt.guard.ts` | Écart majeur |
| Suspension/révocation d'un terminal | Colonne `is_active` présente, flux de contrôle non identifié | migration 030 ; aucun endpoint/service de statut identifié dans l'arborescence examinée | Écart majeur |
| État local d'approbation explicite | Absent du parcours Electron | `main.cjs`, `renderer.js` | Écart majeur |
| Liaison SQLite au tenant | Implémentée dans la PR #63 | `electron-app/electron/db/client.cjs`, `main.cjs` | Conforme pour la continuité locale seulement |
| Reprise et tests d'activation bout en bout | Tests unitaires/partiels présents, scénario complet absent | tests d'enrôlement, JWT et liaison locale | Écart |

## 3. Écarts classés par criticité

### P0 — Bloquants avant toute généralisation

#### P0.1 — Aucun lien serveur entre le JWT et le terminal enregistré

Le `JwtAuthGuard` valide et expose `agentId`, `tenantId`, permissions et services. Il ne construit pas de contexte `deviceId` et ne consulte pas la table `devices`.

Le contrôleur `SyncController` applique ce garde, puis transmet `agentId` et `tenantId` aux services. Aucun contrôle de l'état du terminal n'apparaît dans ce chemin.

Conséquence : un JWT valide pour un agent et un tenant peut accéder aux routes de synchronisation sans démonstration que le poste qui le présente correspond à un terminal enregistré et approuvé. La table `devices` et sa colonne `is_active` ne gouvernent donc pas encore l'accès à la synchronisation.

**Correction d'architecture requise :** définir comment le terminal s'identifie de manière authentifiée, lier cette identité au registre serveur et vérifier l'état actif/approuvé/révoqué avant chaque opération protégée.

#### P0.2 — Le parcours Electron déclare le terminal prêt sans décision serveur

Dans `electron-app/electron/main.cjs` :
- le jeton est chargé depuis `DeviceTokenStore` ;
- le tenant est extrait localement du JWT ;
- `bindTenant` est appelé ;
- `authState` passe à `ready` ;
- `doSync()` est ensuite lancé.

Le handler IPC `eden:device:enroll` accepte un JWT fourni par le renderer, vérifie sa structure et sa persistance chiffrée, lie SQLite et passe également à `ready`. Il ne contacte pas le endpoint `POST /api/v1/devices/enroll` ni un endpoint de vérification d'approbation.

Le renderer ouvre le tableau de bord dès que `authState === 'ready'`.

Conséquence : `ready` signifie aujourd'hui « jeton stocké et tenant local lié », et non « terminal approuvé par le serveur ».

**Correction d'architecture requise :** introduire les états du contrat dans le processus principal Electron et ne permettre le démarrage de la synchronisation qu'après une réponse d'approbation explicite et vérifiée.

#### P0.3 — La configuration de production documentée utilise actuellement le secret partagé, pas un IdP

Le fichier `docker-compose.prod.yml` définit explicitement `AUTH_ALLOW_SHARED_SECRET: "true"` et ne configure ni `JWKS_URL`, ni `JWT_AUDIENCE`, ni `JWT_ISSUER`.

Le fichier `.env.prod.example` confirme ce choix. Le script `scripts/mint-token.mjs` signe hors ligne un JWT HS256 avec le secret partagé, contenant les UUID `agentId` et `tenantId` fournis en arguments, pour une durée de 30 jours.

Le garde de démarrage autorise volontairement ce mode en production lorsque `AUTH_ALLOW_SHARED_SECRET=true`. Le garde JWT utilise alors le secret local pour vérifier le jeton.

Ce mode peut être un choix opérationnel explicite, mais il ne réalise pas le modèle « IdP externe responsable de l'authentification et de l'émission des jetons » décrit dans le contrat. Toute personne disposant du secret partagé peut produire des jetons pour des identifiants agent/tenant qu'elle choisit, sous réserve que les UUID soient valides.

**Décision requise :** choisir explicitement entre (a) intégrer un IdP externe en production, ou (b) conserver temporairement le mode secret partagé avec une politique de risque, de distribution/rotation du secret et d'émission des jetons clairement assumée. Ne pas documenter le mode actuel comme une intégration IdP.

### P1 — Écarts importants à résoudre avant mise en service publique

#### P1.1 — L'issuer n'est pas obligatoire en mode JWKS

`assertAuthStrategy` exige `JWKS_URL` et `JWT_AUDIENCE` en production, mais pas `JWT_ISSUER`. `readIdpConfig` rend l'issuer facultatif et `verifyToken` transmet cette valeur facultative à `jwtVerify`.

Si `JWT_ISSUER` est absent, la vérification ne contraint pas le jeton à l'issuer attendu. Cela affaiblit la séparation entre fournisseurs/autorités d'identité.

**Correction requise :** rendre l'issuer obligatoire en mode JWKS de production, sauf décision documentée et justification technique spécifique.

#### P1.2 — Aucun endpoint de consultation de l'état d'activation identifié

L'arborescence examinée contient le endpoint de création `POST /api/v1/devices/enroll`, mais aucun endpoint dédié permettant à Electron de vérifier l'état serveur d'un terminal, de récupérer une approbation ou de constater une révocation.

**Correction requise :** définir un endpoint authentifié de statut, lié au terminal courant et non à un `deviceId` arbitraire fourni par le client.

#### P1.3 — Le mécanisme d'émission des codes d'appairage est hors du parcours identifié

La migration crée `device_pairing_codes` et le service sait consommer un hash de code. La documentation décrit le format et le hash attendu. En revanche, aucun contrôleur/service d'émission ou d'administration des codes n'a été identifié dans l'arborescence examinée.

**Correction requise :** documenter et sécuriser le composant qui crée les codes, définit leur tenant/store/profil POS, leur expiration et l'acteur autorisé à les émettre.

#### P1.4 — Le throttling peut être local à une instance

`src/device-enrollment.throttle.ts` utilise Redis uniquement si `REDIS_URL` est défini ; sinon, il utilise le stockage mémoire par défaut. Le `docker-compose.prod.yml` examiné ne fournit pas `REDIS_URL`.

Avec plusieurs instances API, un compteur mémoire par instance ne fournit pas une limite globale cohérente. Le throttling actuel est par défaut basé sur le tracker IP de Nest Throttler, et non une preuve d'identité matérielle.

**Correction requise :** décider si l'API sera mono-instance ou multi-instance ; si multi-instance, imposer un stockage Redis partagé et tester la limite distribuée. Maintenir la règle que le fingerprint n'est pas un credential.

## 4. Points déjà correctement conçus

- La consommation du code est atomique et réalisée dans la transaction qui crée le terminal.
- Un échec d'insertion doit annuler la consommation du code.
- Le fingerprint est explicitement décrit comme un identifiant déclaratif, pas une preuve d'identité.
- L'API valide les jetons sur chaque requête protégée, en mode JWKS ou secret partagé selon la configuration.
- Les claims agent et tenant sont vérifiés comme UUID.
- La liaison SQLite de la PR #63 protège contre le changement silencieux de tenant et préserve les données locales.
- Le stockage du jeton Electron utilise `safeStorage` et refuse le fallback en clair.
- Les tests couvrent la concurrence de consommation du code, le rollback, le throttling de l'endpoint d'enrôlement, la structure du JWT et la liaison locale au tenant.

Ces éléments sont utiles mais ne remplacent pas la preuve d'approbation du terminal.

## 5. Décisions d'architecture à prendre

Avant d'implémenter, les décisions suivantes doivent être écrites :
1. Le mode cible de production est-il IdP externe obligatoire, ou secret partagé temporaire ?
2. Quel acteur autorisé émet un code d'appairage et quel acteur approuve le terminal ?
3. Le code d'activation crée-t-il un terminal en attente ou immédiatement approuvé ?
4. Comment le JWT ou un credential d'appareil lie-t-il cryptographiquement le terminal à `deviceId` ?
5. Quelle preuve serveur Electron conserve-t-il et à quelle fréquence est-elle renouvelée ?
6. Quelle durée d'accès hors ligne est acceptée après la dernière approbation ?
7. Comment la révocation est-elle appliquée aux requêtes et aux données locales ?
8. Quelle est la procédure de remplacement/réinstallation d'un terminal ?

## 6. Plan de correction recommandé

1. **Décision IdP et modèle de credential terminal.** Ne pas coder avant l'arbitrage du mode d'authentification de production.
2. **Contrat serveur d'état du terminal.** Définir les états persistés, les acteurs d'approbation, les transitions et l'audit.
3. **Liaison cryptographique du terminal.** Définir comment le terminal prouve qu'il est le terminal enregistré ; ne pas utiliser le fingerprint comme secret.
4. **Garde d'accès terminal.** Ajouter le contrôle serveur du statut du terminal aux routes protégées de synchronisation et aux autres opérations qui doivent être réservées aux terminaux approuvés.
5. **Parcours Electron.** Remplacer le passage direct à `ready` par la machine à états ; bloquer sync jusqu'à approbation confirmée.
6. **Émission des codes.** Définir le parcours administratif et les permissions de création/révocation des codes.
7. **Tests E2E.** Tester activation, attente, approbation, refus, réseau indisponible, redémarrage, révocation, changement de tenant, réinstallation et sync avant/après approbation.
8. **Déploiement.** Valider la configuration réelle de production, les secrets, le rate limiting distribué, les journaux et la procédure de récupération.

## 7. Décision de préparation

**NO-GO** pour considérer le cycle de vie des terminaux comme complet ou pour généraliser le déploiement.

La PR #63 peut rester ouverte comme amélioration de la liaison locale SQLite/tenant. Elle ne doit pas être considérée comme l'implémentation de l'approbation des terminaux.

Cet audit est une analyse statique de la révision indiquée. Les tests CI existants n'ont pas été relancés ici et aucune conclusion de réussite d'exécution n'est formulée.
