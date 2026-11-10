# Conception — credential cryptographique et approbation des terminaux

> **Statut :** proposition technique cible, à valider avant implémentation  
> **Branche de travail :** `docs/device-activation-contract`  
> **Périmètre :** API Sync Engine, client Electron et fournisseur d'identité  
> **Aucun code fonctionnel n'est modifié par ce document.**

## 1. Décision d'architecture recommandée

Eden Gestion doit distinguer trois preuves indépendantes :

1. **Identité de l'agent** : le fournisseur d'identité authentifie l'utilisateur et émet un jeton destiné à l'API.
2. **Identité du terminal** : Electron possède une clé cryptographique propre à cette installation/terminal et prouve qu'il en détient la clé privée.
3. **Approbation du terminal** : l'API conserve la décision administrative et vérifie que le terminal est toujours autorisé.

Un JWT utilisateur valide ne prouve pas l'identité du terminal. Une clé de terminal valide ne prouve pas l'identité de l'agent. La possession des deux ne remplace pas la décision d'approbation du serveur.

**Recommandation :** utiliser une paire de clés asymétriques générée localement par Electron, enregistrer la clé publique dans le registre serveur et exiger une preuve de possession liée aux requêtes protégées. Le modèle de preuve HTTP doit s'appuyer sur un mécanisme standard de type DPoP (Demonstrating Proof of Possession), implémenté avec une bibliothèque JOSE éprouvée et conformément à sa spécification, plutôt que sur une signature propriétaire improvisée.

## 2. Modèle d'identité

| Élément | Rôle | Autorité |
|---|---|---|
| `agentId` | Identité de la personne authentifiée | IdP, claim `sub` validé par l'API |
| `tenantId` | Entreprise et périmètre de données | API, rattaché au code d'activation et confirmé par le registre |
| `deviceId` | Identité du terminal enregistré | API, UUID généré par le serveur |
| clé publique du terminal | Identifiant cryptographique du credential d'appareil | Générée par Electron, enregistrée et liée par l'API |
| clé privée du terminal | Preuve de possession | Générée et conservée par Electron ; jamais envoyée au serveur |
| `activationCode` | Autorisation temporaire de demander l'enregistrement | Généré, expiré et consommé côté serveur |
| état d'approbation | Autorisation d'utiliser le terminal | API, selon une action administrative autorisée |

Le fingerprint matériel existant reste une métadonnée de diagnostic et de détection d'anomalies. Il ne doit être ni une clé cryptographique, ni un secret, ni la preuve de possession du terminal.

## 3. Génération et conservation de la clé du terminal

### 3.1 À la première activation

Electron génère une paire de clés asymétriques dédiée au terminal :
- algorithme recommandé : ECDSA P-256 avec SHA-256, si la bibliothèque et la plateforme offrent une prise en charge stable ;
- clé privée non exportée en clair hors du processus principal ;
- clé publique exportée dans un format standard (JWK public ou SPKI) ;
- identifiant de clé (thumbprint) calculé selon une méthode standard et stable.

Le choix définitif de l'algorithme doit être fixé dans une version du contrat et testé sur les versions Windows supportées. Ne pas accepter un algorithme arbitraire annoncé par le client.

### 3.2 Stockage local

La clé privée doit être chiffrée avec le stockage sécurisé du système via Electron `safeStorage`, avec contrôle du backend réellement utilisé. Les permissions de fichiers seules ne sont pas une protection suffisante.

La clé privée ne doit jamais :
- être transmise à l'API ou à l'IdP ;
- être écrite dans les logs, les rapports d'erreur ou les sauvegardes en clair ;
- être intégrée au binaire ou partagée entre installations ;
- être remplacée silencieusement en cas d'erreur de déchiffrement.

Si le stockage sécurisé devient indisponible ou si la clé ne peut plus être déchiffrée, Electron bloque l'authentification distante et demande une procédure de récupération contrôlée. Il ne génère pas automatiquement une nouvelle clé qui pourrait être interprétée comme le même terminal.

### 3.3 Portée de la clé

Une clé représente un credential d'installation/terminal, pas une personne et pas un tenant. Plusieurs agents autorisés peuvent utiliser le même terminal si la politique métier le permet ; chaque requête doit néanmoins porter l'identité de l'agent actuellement authentifié.

La rotation de clé est une opération explicite, auditée et autorisée par le serveur.

## 4. Parcours cible d'activation

### Étape A — Préparation locale

1. Electron initialise SQLite sans déclarer le terminal approuvé.
2. Electron génère la paire de clés.
3. Electron conserve la clé privée chiffrée et prépare la clé publique.
4. L'état reste `LOCAL_REGISTERED`.

Aucune synchronisation n'est autorisée.

### Étape B — Enregistrement par code d'activation

Electron transmet à l'API :
- le code d'activation ;
- le nom et les métadonnées du terminal ;
- la clé publique ;
- le type/version du credential ;
- le fingerprint matériel à titre informatif.

L'API :
1. valide le format et le hash du code ;
2. consomme le code une seule fois dans une transaction ;
3. détermine le tenant, le magasin et le profil POS depuis l'enregistrement serveur du code ;
4. crée le terminal avec un statut initial `pending_approval` ;
5. enregistre la clé publique et son thumbprint ;
6. journalise l'événement et retourne `deviceId`, `tenantId` et l'état `pending_approval`.

L'API ne fait confiance à aucun `tenantId` transmis par Electron. Elle ne considère pas le fingerprint comme preuve de possession. Un code consommé ne peut pas créer deux terminaux.

**Décision recommandée :** un code d'activation enregistre le terminal mais ne l'approuve pas automatiquement. L'approbation est une décision distincte prise par un acteur autorisé de l'entreprise. Une politique d'auto-approbation éventuelle devra être explicitement définie, limitée et auditée ; elle ne doit pas être le comportement implicite.

### Étape C — Authentification de l'agent

1. L'agent s'authentifie auprès de l'IdP via un flux adapté à une application desktop.
2. L'IdP émet un jeton d'accès destiné à Sync Engine, avec `iss`, `aud`, `sub`, `exp` et les claims autorisés.
3. Electron conserve les jetons selon la politique de stockage sécurisé.
4. L'API vérifie cryptographiquement le jeton et résout `agentId` et les autorisations.

L'IdP n'approuve pas le terminal et ne choisit pas le tenant de la base SQLite.

### Étape D — Approbation administrative

Un acteur autorisé consulte les terminaux en attente et approuve ou refuse le terminal dans le périmètre de son tenant.

L'API vérifie l'autorisation de cet acteur, applique la transition dans une transaction et conserve :
- l'acteur décisionnaire ;
- le tenant et le terminal concernés ;
- l'état précédent et le nouvel état ;
- la date serveur ;
- le motif ou commentaire non sensible ;
- un identifiant de corrélation.

Une demande provenant du terminal lui-même ne peut pas approuver ce terminal.

### Étape E — Preuve de possession et contrôle de statut

Avant l'accès aux opérations protégées, Electron présente :
- le jeton d'accès de l'agent ;
- une preuve DPoP signée par la clé privée du terminal.

L'API vérifie :
- la signature du jeton agent, son issuer, son audience et sa durée ;
- la preuve DPoP, sa clé et son thumbprint ;
- la liaison de la clé au `deviceId` enregistré ;
- le tenant et l'agent autorisés ;
- l'état courant du terminal (`approved`, non suspendu, non révoqué) ;
- les protections anti-rejeu et la correspondance de la preuve avec la méthode et l'URL de la requête.

Le serveur dérive le contexte terminal à partir de la preuve vérifiée et du registre. Il ne fait pas confiance à un `deviceId` arbitraire dans le corps de requête.

Le contrôle de statut est effectué pour chaque requête protégée. Une mise en cache ne peut être introduite que si son délai maximal de révocation est explicitement accepté, mesuré et testé. La politique cible est le contrôle serveur en ligne à chaque opération.

## 5. Contrat des endpoints — proposition

Les routes ci-dessous sont des propositions de conception et ne sont pas présentées comme déjà implémentées.

| Opération | Authentification | Fonction |
|---|---|---|
| `POST /api/v1/devices/enroll` | Code d'activation à usage unique + clé publique | Créer un terminal en attente |
| `GET /api/v1/devices/me/status` | Jeton agent + preuve de possession du terminal | Lire l'état du terminal courant |
| `POST /api/v1/devices/me/rotate-key` | Agent autorisé + ancienne clé prouvée + nouvelle clé publique | Rotation contrôlée |
| `POST /api/v1/admin/devices/:id/approve` | Agent administrateur + tenant autorisé | Approuver |
| `POST /api/v1/admin/devices/:id/reject` | Agent administrateur + tenant autorisé | Refuser |
| `POST /api/v1/admin/devices/:id/revoke` | Agent administrateur + tenant autorisé | Révoquer |
| `POST /api/v1/admin/devices/:id/reactivate` | Agent administrateur + tenant autorisé | Réactiver selon politique |

Les endpoints administratifs doivent contrôler le tenant côté serveur, appliquer le principe du moindre privilège et écrire un événement d'audit.

## 6. Modèle de données serveur recommandé

Faire évoluer le modèle `devices` existant plutôt que créer un registre concurrent.

Champs conceptuels à prévoir :
- `status` : `pending_approval`, `approved`, `rejected`, `revoked` ;
- `public_key` ou référence vers un stockage de credentials public ;
- `key_thumbprint` ;
- `key_algorithm` et version de format ;
- `approved_at`, `approved_by` ;
- `revoked_at`, `revoked_by`, `revocation_reason` ;
- `last_seen_at` ;
- `credential_version` ou identifiant de génération ;
- timestamps de création et mise à jour.

Le champ historique `is_active` ne doit pas être interprété comme équivalent à `approved`. Prévoir une migration compatible, une correspondance explicite des anciennes lignes et une stratégie de retour arrière. Ne pas déduire rétroactivement qu'un terminal existant est approuvé simplement parce que `is_active=true`.

L'unicité tenant/fingerprint actuellement présente doit être réévaluée : un fingerprint matériel est mutable, peut être partagé ou renouvelé lors d'une réinstallation. L'identité cryptographique doit reposer sur le credential public et son association au `deviceId`, non sur le fingerprint.

## 7. Anti-rejeu et liaison des requêtes

Utiliser une implémentation conforme à DPoP ou un mécanisme standard équivalent. Les preuves doivent être liées à la requête et contenir les éléments exigés par la spécification retenue, notamment méthode HTTP, URI cible, horodatage, identifiant unique de preuve et liaison au jeton d'accès lorsque le profil le requiert.

Le serveur doit :
- vérifier la signature avec la clé publique associée au terminal ;
- vérifier le thumbprint attendu ;
- rejeter les preuves expirées ou hors fenêtre d'horloge ;
- empêcher la réutilisation d'un identifiant de preuve pendant la fenêtre anti-rejeu, avec un stockage partagé entre instances API ;
- vérifier que la méthode et l'URI correspondent à la requête réelle ;
- ne jamais accepter une clé publique fournie à chaque requête sans la comparer au credential enregistré.

Ne pas développer un schéma de signature maison ni inventer des en-têtes cryptographiques incompatibles avec un standard.

## 8. Révocation et fonctionnement hors ligne

La révocation est décidée et persistée côté API. À partir de cette décision :
- les nouvelles requêtes protégées sont refusées ;
- les jetons d'accès ne suffisent plus à autoriser le terminal ;
- la prochaine vérification Electron fait passer l'état local à `SERVER_REJECTED` ou à un état local dédié `REVOKED` ;
- les données SQLite sont conservées ;
- l'outbox n'est pas effacée.

Hors ligne, le client ne peut pas découvrir instantanément une révocation. Pour Eden Gestion, il faut donc fixer une limite d'utilisation hors ligne après la dernière approbation valide. Recommandation initiale : ne pas autoriser de nouvelles opérations sensibles au-delà d'un bail d'approbation signé/renouvelé et de durée courte, tout en conservant les données et en présentant clairement l'état de connexion. La durée exacte est une décision métier/sécurité à mesurer ; elle ne doit pas être codée arbitrairement.

Le mode hors ligne ne transforme jamais un terminal en terminal approuvé par lui-même. Le client peut seulement appliquer une preuve d'approbation antérieure pendant sa période de validité explicitement définie.

## 9. Réinstallation, perte et remplacement

- **Redémarrage normal :** restaurer la clé privée chiffrée, le `deviceId`, le `tenantId` et le dernier état connu ; revalider en ligne avant sync.
- **Réinstallation sans perte des données protégées :** réutiliser le credential uniquement si la clé privée reste disponible et que la politique OS le permet.
- **Clé perdue ou stockage OS inaccessible :** ne pas réutiliser le fingerprint pour reprendre l'identité ; procédure de récupération administrative, révocation de l'ancien credential puis nouvel enrôlement.
- **Remplacement matériel :** créer un nouveau credential/terminal, approuver le nouveau terminal et révoquer l'ancien selon la politique de transfert.
- **Base SQLite déjà liée :** ne jamais changer de tenant automatiquement. La migration des données entre entreprises est un processus distinct, autorisé et audité.

## 10. Contrôles et tests obligatoires

### Tests de protocole et API
- clé publique enregistrée et liée au terminal créé ;
- signature valide acceptée, signature invalide refusée ;
- preuve d'un autre terminal refusée ;
- preuve liée à une autre méthode ou URL refusée ;
- preuve expirée ou rejouée refusée, y compris entre plusieurs instances API ;
- jeton agent valide mais terminal en attente refusé ;
- terminal approuvé mais agent non autorisé refusé ;
- agent valide et terminal révoqué refusés ;
- tenant du JWT différent du tenant du terminal refusé ;
- changement de clé sans autorisation refusé ;
- rotation autorisée auditée et ancienne clé invalidée selon la transition ;
- statut inconnu ou base de registre indisponible : refus par défaut.

### Tests Electron / Windows
- génération de clé une seule fois ;
- clé privée jamais envoyée au serveur ni écrite en clair ;
- stockage OS chiffré disponible et indisponible ;
- redémarrage et restauration ;
- profil Windows différent ou réinstallation ;
- clé corrompue/perdue : blocage contrôlé, aucune génération silencieuse ;
- activation interrompue et reprise idempotente ;
- aucune sync avant approbation ;
- révocation reçue et conservation de SQLite/outbox.

### Tests de bout en bout
- nouvel ordinateur → activation → enregistrement pending → authentification agent → approbation admin → preuve de possession → premier pull/push ;
- refus explicite ;
- panne réseau à chaque étape ;
- redémarrage à chaque état ;
- deux instances API et anti-rejeu partagé ;
- remplacement du terminal et révocation de l'ancien.

## 11. Décisions et séquence de réalisation

Ordre recommandé :

1. Valider DPoP comme standard de preuve de possession et sélectionner une bibliothèque JOSE maintenue.
2. Définir le flux desktop d'authentification IdP et le lien agent/tenant.
3. Définir les rôles administratifs autorisés à approuver, refuser et révoquer.
4. Concevoir les migrations de `devices` et la compatibilité des enregistrements existants.
5. Définir le stockage/rotation de clé Electron sur Windows.
6. Définir le bail hors ligne et la politique de révocation.
7. Écrire les contrats OpenAPI/DTO et les tests de protocole avant l'implémentation.
8. Implémenter sur une branche dédiée ; ne pas modifier la PR #63 tant que le périmètre de liaison SQLite reste séparé.
9. Réaliser les tests intégrés API/PostgreSQL/Redis/Electron et une validation sur machine Windows propre.
10. Réexaminer les PR et appliquer les critères Go/No-Go.

## 12. Décision de sécurité

Le système ne doit jamais assimiler :
- un JWT agent valide à une approbation du terminal ;
- un fingerprint à un credential ;
- un terminal créé à un terminal approuvé ;
- un succès HTTP à une preuve de statut ;
- une panne réseau à un refus ;
- `is_active=true` à une approbation complète ;
- une base SQLite liée à un tenant à une identité de terminal authentifiée.

**Principe final :** l'agent s'authentifie auprès de l'IdP ; le terminal prouve la possession de sa clé privée ; l'API relie les deux au registre et décide si ce terminal est autorisé. La synchronisation n'est permise que lorsque les trois conditions sont satisfaites.
