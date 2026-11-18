# Spécification de provisioning — Eden Gestion

**Version :** 0.2  
**Statut :** Brouillon consolidé — conception, non déployable en l’état  
**Périmètre :** provisioning des identités, appartenances, tenant actif et claims JWT  
**Système concerné :** `tshibandachris/sync-engine`

## 1. Objectif et principes

Définir un processus serveur contrôlé qui relie une identité Supabase Auth à un agent Eden Gestion, à une entreprise (tenant), à ses permissions et, lorsque nécessaire, à ses services autorisés.

Principes directeurs :

- Supabase Auth est le fournisseur d'identité. La base PostgreSQL de `sync-engine` reste la source de vérité métier.
- L'isolation multi-tenant est imposée par l'API et PostgreSQL RLS ; un claim JWT ne remplace pas les contrôles d'appartenance ni les politiques RLS.
- Les données métier d'autorisation sont établies par le backend de provisioning, jamais par le client.
- Le refus est la règle en cas d'identité, d'appartenance ou de claims manquants, ambigus ou invalides.
- La V1 privilégie un modèle global et explicite plutôt qu'un contexte de tenant implicite choisi par chaque appareil.

## 2. Décisions d'architecture confirmées

1. Un utilisateur Supabase peut appartenir à plusieurs entreprises.
2. Un seul tenant est actif à la fois pour un utilisateur Supabase en V1.
3. Chaque JWT contient un seul `tenantId` actif.
4. Le tenant actif est déterminé et validé côté serveur. Le client ne peut pas imposer arbitrairement un tenant.
5. Le changement de tenant actif met à jour le contexte global de l'utilisateur, et non un contexte indépendant par appareil ou session.
6. Plusieurs appareils peuvent utiliser le même compte, mais ils partagent le même tenant actif en V1.
7. Deux appareils utilisant le même compte ne peuvent donc pas travailler simultanément dans deux tenants distincts.
8. Les claims métier proviennent exclusivement de `app_metadata`. `user_metadata` n'est jamais une source d'autorisation.
9. Le Custom Access Token Hook est bloquant : si les claims obligatoires sont absents ou invalides, l'émission du jeton doit être refusée.
10. Le hook ne choisit pas le tenant et ne consulte pas de table métier ; il transmet le contexte déjà provisionné dans `app_metadata`.
11. La légitimité des `service_ids` par rapport au tenant actif est vérifiée par le backend de provisioning. Les services restent gérés dans la base `sync-engine`, pas dans Supabase.
12. La V2 pourra étudier un tenant indépendant par session ou appareil, sous réserve d'un contexte serveur vérifiable, d'une isolation stricte et d'une révocation par session.

## 3. Répartition des responsabilités

### Supabase Auth

- Authentifier l'utilisateur et émettre les JWT.
- Fournir une identité stable (`sub`).
- Exécuter le Custom Access Token Hook bloquant avant émission du jeton.
- Stocker dans `app_metadata` uniquement les attributs métier explicitement provisionnés par le backend autorisé.

### Backend de provisioning

- Être le seul composant autorisé à attribuer ou modifier les claims métier dans `app_metadata`.
- Vérifier l'identité, l'agent, le tenant, les appartenances, les permissions et les services.
- Déterminer le tenant actif et recalculer les droits à chaque changement de contexte.
- Enregistrer les opérations sensibles dans un journal d'audit.
- Ne jamais exposer la clé Supabase `service_role` au navigateur, à Electron ou à tout autre client.

### API sync-engine

- Vérifier signature, algorithme, issuer, audience et expiration du JWT.
- Exiger et valider les claims d'identité et de contexte.
- Appliquer le contexte tenant aux transactions et laisser PostgreSQL RLS assurer l'isolation.
- Ne pas considérer la présence d'un `tenantId` dans le JWT comme une preuve suffisante d'appartenance métier.
- Ne pas créer silencieusement une entreprise sur la seule base d'un claim reçu.

### Clients Electron / appareils

- Présenter les demandes de connexion et de changement de tenant.
- Ne jamais écrire `app_metadata`, choisir librement les permissions ou fabriquer un contexte tenant.
- Ne jamais détenir de secret administratif Supabase.
- Accepter que le changement de tenant global affecte les autres appareils connectés au même compte.

## 4. Modèle d'appartenance V1

Le modèle logique doit permettre une relation plusieurs-à-plusieurs entre les utilisateurs et les entreprises, avec une association vérifiable à un agent Eden Gestion.

Le schéma physique exact, les clés étrangères, les contraintes d'unicité et la cardinalité entre identité Supabase et agent doivent être spécifiés avant toute migration. Il ne faut pas déduire automatiquement qu'un utilisateur correspond à un seul agent ou qu'un agent correspond à un seul utilisateur sans décision métier explicite.

Pour chaque activation, le backend doit vérifier au minimum :

- que l'identité Supabase existe et est dans un état autorisé ;
- que l'agent associé existe et est actif ;
- que le tenant existe et est actif ;
- que l'appartenance agent/utilisateur au tenant est valide ;
- que les permissions attribuées sont autorisées pour cette appartenance ;
- que chaque service demandé appartient bien au tenant actif et est accessible à cet agent.

Une appartenance absente, révoquée, suspendue ou incohérente entraîne un refus fermé.

## 5. Contrat des claims JWT

Le contrat métier attendu par l'API comprend :

| Claim | Règle V1 |
|---|---|
| `sub` | Identifiant Supabase Auth, obligatoire, UUID |
| `agent_id` | Identifiant agent, obligatoire, UUID |
| `tenantId` | Tenant actif, obligatoire, UUID |
| `permissions` | Tableau de permissions autorisées ; peut être vide si le rôle le permet |
| `service_ids` | Tableau facultatif d'identifiants de services autorisés dans le tenant actif |

Les claims métier doivent être lus depuis `app_metadata` par le hook. Les valeurs fournies par `user_metadata`, les paramètres client ou des en-têtes non vérifiés ne peuvent pas les remplacer.

### 5.1 Permissions V1

La liste blanche de référence du hook V5 est :

- `courrier:read`
- `courrier:register`
- `courrier:assign`
- `courrier:manage`
- `clearance:confidentiel`
- `clearance:secret`
- `devices:read`
- `devices:approve`
- `devices:reject`
- `devices:revoke`

Règles :

- Toute permission inconnue est rejetée.
- Les doublons sont rejetés au provisioning.
- Le joker `*` n'est pas provisionné.
- Les droits nécessaires sont attribués explicitement. En particulier, ne pas déduire que `courrier:manage` accorde automatiquement les droits de classification ou de confidentialité.
- Les permissions sont recalculées à partir des règles métier du tenant et de l'agent ; le client ne peut pas les augmenter.

### 5.2 Services

Les `service_ids` sont des UUID référencés dans la base métier sync-engine. Le backend doit vérifier leur existence, leur état, leur appartenance au tenant actif et leur autorisation pour l'agent avant toute écriture dans `app_metadata`.

Le provisioning doit refuser les doublons, les identifiants invalides et tout service hors du tenant actif. La limite du contrat de hook V5 est de 50 identifiants.

## 6. Provisioning initial

Le processus serveur de provisioning initial doit suivre cet ordre logique :

1. Recevoir une demande administrative authentifiée et autorisée.
2. Résoudre l'identité Supabase existante ; ne pas créer implicitement un utilisateur sur la seule base d'une requête client.
3. Vérifier l'existence et l'état de l'agent.
4. Vérifier l'existence et l'état du tenant.
5. Vérifier l'appartenance de l'agent/utilisateur au tenant.
6. Calculer les permissions selon les règles métier.
7. Résoudre et valider les services autorisés.
8. Construire un ensemble cohérent de claims métier.
9. Écrire les claims dans `app_metadata` au moyen d'un composant serveur privilégié.
10. Enregistrer l'acteur, la cible, le tenant, l'opération, le résultat et l'horodatage dans un journal d'audit sans y recopier de secrets ni de jetons.
11. Permettre au client d'obtenir une nouvelle session/un nouveau JWT, puis vérifier le résultat côté API.

Les étapes doivent échouer de manière fermée. Une erreur partielle ne doit pas laisser un contexte incohérent considéré comme provisionné.

## 7. Changement du tenant actif — V1 globale

Le changement de tenant est une opération administrative/métier exécutée côté serveur :

1. Le client demande le changement de contexte.
2. Le backend identifie l'utilisateur à partir d'une session authentifiée, jamais à partir d'un `user_id` librement fourni comme preuve.
3. Le backend vérifie que l'utilisateur/agent possède une appartenance active au tenant demandé.
4. Le backend recalcule les permissions et les services pour ce tenant.
5. Le backend met à jour atomiquement, autant que le permettent les mécanismes disponibles, le contexte global de l'utilisateur dans `app_metadata`.
6. Le changement est journalisé.
7. Le client renouvelle sa session et l'API vérifie le nouveau JWT avant d'autoriser les opérations dans le nouveau tenant.

**Limite multi-appareils :** comme le contexte est global par utilisateur, les appareils utilisant le même compte convergent vers le tenant actif le plus récemment provisionné. Un ancien JWT peut conserver l'ancien contexte jusqu'à son expiration ; la stratégie de réduction de cette fenêtre et de révocation doit être définie avant la mise en production.

Le client ne doit pas contourner ce processus en envoyant simplement un autre `tenantId` dans le corps d'une requête métier.

## 8. Protection de app_metadata et des secrets

- Seul le backend de provisioning, exécuté dans un environnement serveur de confiance, peut utiliser les privilèges nécessaires pour modifier `app_metadata`.
- La clé `service_role` reste côté serveur, dans un gestionnaire de secrets ou une configuration d'environnement protégée.
- Aucun secret privilégié ne doit être inclus dans le code source, les journaux, les réponses API, les bundles Electron ou les variables accessibles au renderer.
- Les clients ne peuvent modifier ni les appartenances, ni les permissions, ni `agent_id`, ni `tenantId`, ni les `service_ids`.
- Les opérations d'administration doivent être authentifiées, autorisées et auditées.

## 9. Révocation et sessions existantes

La mise à jour de `app_metadata` ne réécrit pas les JWT déjà émis. La révocation d'un utilisateur, d'une appartenance, d'un agent ou d'un tenant doit donc définir une stratégie explicite couvrant :

- la durée de vie des JWT ;
- le renouvellement et la révocation des sessions Supabase ;
- le comportement de l'API face à un ancien JWT encore cryptographiquement valide ;
- les opérations hors ligne et la reprise de synchronisation ;
- la propagation de la révocation sur les appareils.

Aucune garantie de révocation immédiate ne doit être annoncée tant qu'un mécanisme vérifié n'est pas conçu et testé. La V1 doit documenter cette fenêtre de validité résiduelle et fixer une politique acceptable avant production.

## 10. Contrat du Custom Access Token Hook V5

Le hook V5 est le contrat de référence du présent brouillon, pas une instruction de déploiement.

- Fonction attendue : `public.eden_custom_access_token_hook(event jsonb) returns jsonb`.
- Lecture exclusive des claims métier depuis `event -> 'claims' -> 'app_metadata'`.
- Validation de `sub`, `agent_id` et `tenantId` comme UUID.
- Validation stricte des permissions selon la liste blanche ci-dessus.
- Validation des `service_ids` comme tableau de UUID, avec limite de 50.
- Claims requis absents ou invalides : refus bloquant de l'émission.
- Claims Supabase réservés : ne pas les écraser.
- Pas de lecture de tables métier dans le hook ; pas de choix de tenant par le hook.
- Pas de `SECURITY DEFINER` ; `search_path = ''`.
- Accorder uniquement les privilèges d'exécution nécessaires à `supabase_auth_admin` et retirer les privilèges d'exécution inutiles aux rôles clients.
- Ne pas supposer que le code HTTP observé par le client sera exactement 403 : le comportement externe des erreurs de hook doit être vérifié avec un test réel.

Le hook ne remplace pas le provisioning. Il valide et transmet un contexte déjà écrit par le backend.

## 11. Contrôles côté API et isolation RLS

À chaque requête authentifiée, l'API doit :

1. Vérifier la signature du JWT avec le JWKS configuré, ainsi que l'algorithme autorisé.
2. Vérifier issuer, audience et expiration.
3. Exiger les claims `sub`, `agent_id` et `tenantId` et valider leur format.
4. Rejeter les claims incohérents ou les contextes non autorisés.
5. Poser le tenant courant dans le contexte transactionnel utilisé par les politiques RLS.
6. Conserver `FORCE ROW LEVEL SECURITY` sur les tables métier concernées et éviter tout chemin d'accès qui contournerait RLS.
7. Ne jamais considérer un identifiant tenant fourni dans le corps de la requête comme supérieur au contexte validé du JWT.

**Point d'audit à traiter avant production :** l'audit statique a relevé un chemin dans lequel l'API peut insérer automatiquement un tenant lors d'une première requête authentifiée (`INSERT ... ON CONFLICT DO NOTHING`). Ce comportement doit être réexaminé : un claim tenant ne doit pas entraîner la création implicite d'une entreprise ni transformer un contexte non provisionné en contexte autorisé. Le comportement attendu doit être fixé et couvert par des tests avant toute mise en production.

## 12. Journalisation et audit

Journaliser au minimum :

- l'acteur administratif ou le processus système ;
- l'identité cible et l'agent concerné ;
- le tenant concerné ;
- le type d'opération (provisioning, changement de tenant, modification de droits, suspension, révocation) ;
- les changements de référence utiles (sans secrets ni JWT) ;
- le résultat, la cause normalisée du refus et l'horodatage.

Les journaux doivent être protégés contre les modifications non autorisées et ne doivent pas exposer les clés, jetons ou données sensibles inutiles.

## 13. Évolution V2 — contexte indépendant par session/appareil

La V2 pourra permettre à deux appareils d'un même utilisateur de travailler dans des tenants différents, mais uniquement avec un modèle explicite et vérifiable.

Conditions minimales de conception :

- association serveur contrôlée entre une session/appareil authentifié et un tenant ;
- identifiant de contexte/session non falsifiable et vérifié côté serveur ;
- claims calculés pour ce contexte, sans réutiliser aveuglément le tenant global de V1 ;
- contrôle d'appartenance, de permissions et de services pour chaque contexte ;
- révocation indépendante par session/appareil ;
- isolation RLS maintenue pour chaque transaction ;
- prise en compte du mode offline-first, des files d'attente et des changements de contexte lors de la synchronisation ;
- tests croisés multi-tenant, multi-session, révocation et rejeu.

Cette évolution est hors périmètre de la V1. Elle nécessite une conception dédiée, des tests de sécurité et une validation explicite avant implémentation.

## 14. Tests d'acceptation requis avant activation

### Provisioning et claims

- Un utilisateur non provisionné ne reçoit pas de JWT métier exploitable.
- Un `agent_id` absent, invalide ou non associé est refusé.
- Un `tenantId` absent, invalide, inactif ou sans appartenance est refusé.
- Les valeurs présentes uniquement dans `user_metadata` sont ignorées.
- Une permission inconnue, un joker ou un doublon est refusé.
- Un `service_id` inexistant, dupliqué ou appartenant à un autre tenant est refusé.
- Un provisioning réussi écrit uniquement les claims calculés côté serveur et produit un événement d'audit.

### Changement de tenant et appareils

- Un utilisateur multi-appartenances peut activer un tenant auquel il est effectivement autorisé.
- Un utilisateur ne peut pas activer un tenant sans appartenance.
- Le changement d'un tenant actif est visible comme changement global pour le compte en V1.
- Un ancien JWT est traité selon la politique de validité/révocation explicitement retenue.
- Un client ne peut pas modifier son tenant actif en envoyant un simple champ `tenantId`.

### API et RLS

- Un JWT avec mauvaise signature, mauvais issuer, mauvaise audience ou expiré est refusé.
- Les claims obligatoires manquants ou incohérents sont refusés.
- Deux tenants ne peuvent pas lire ou modifier les données l'un de l'autre.
- Les requêtes sans contexte tenant valide échouent de manière fermée.
- Une première requête authentifiée ne crée pas implicitement un tenant métier.
- Les parcours de synchronisation offline-first ne contournent pas les contrôles de tenant lors de la reprise.

### Intégration Supabase réelle

- Vérifier l'algorithme et la clé active de signature dans le projet réel.
- Vérifier la configuration issuer/audience et le JWKS sur un JWT de test non sensible.
- Vérifier l'exécution du hook, ses privilèges effectifs, son timeout et le comportement d'erreur vu par le client.
- Vérifier le renouvellement de session après modification de `app_metadata`.

Les tests unitaires et l'analyse statique ne remplacent pas ces vérifications d'intégration réelles.

## 15. Points restant à spécifier

Avant implémentation ou activation, il reste à décider et documenter :

1. Le schéma physique des appartenances et la cardinalité utilisateur ↔ agent.
2. Les règles de création, suspension et désactivation d'un tenant.
3. La source de vérité des rôles et la matrice rôle → permissions.
4. La politique exacte de révocation des JWT et sessions déjà émis.
5. La correction du chemin de création automatique de tenant identifié dans l'audit.
6. Les contrôles métier complets sur les agents et les services avant écriture des claims.
7. Le comportement exact du hook sur le projet Supabase réel, y compris les privilèges et erreurs.
8. La confirmation de la clé de signature active et du contrat JWKS.
9. Les limites et règles de reprise offline lorsque le tenant actif change ou qu'une appartenance est révoquée.

## 16. Limites de ce document

Ce document consolide les décisions d'architecture et décrit le processus cible. Il ne constitue ni une preuve d'implémentation, ni une autorisation d'activer le hook, ni une validation de production.

Ce commit documentaire n'inclut pas :

- de code applicatif ou de logique de provisioning ;
- de migration SQL ou de création de table ;
- de création ou d'activation du Custom Access Token Hook ;
- de création d'utilisateur Supabase ou de modification de `app_metadata` ;
- de changement de configuration, de secret ou de déploiement ;
- de modification des fichiers locaux ou des files outbox.

**Décision de référence :** V1 conserve un tenant actif global par utilisateur Supabase ; la V2 étudiera le contexte indépendant par session/appareil sans affaiblir l'isolation multi-tenant.
