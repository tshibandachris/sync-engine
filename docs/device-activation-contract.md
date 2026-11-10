# Contrat d'activation et d'identité des terminaux

> **Statut :** proposition d'architecture à valider  
> **Périmètre :** client Electron, API Sync Engine et fournisseur d'identité (IdP)  
> **Décision structurante :** ce document définit le contrat cible. Il ne prétend pas que tous les échanges décrits sont déjà implémentés.

## 1. Objectif

Définir comment un terminal Eden Gestion acquiert, conserve, présente et perd son identité au cours de son cycle de vie.

Le problème dépasse le rattachement de SQLite à un tenant. Le système doit garantir qu'un terminal local ne peut ni s'attribuer une entreprise, ni déclarer lui-même son approbation, ni synchroniser avant que le serveur ait établi son identité et ses droits.

Règle fondatrice :

> Le client conserve l'état local et exécute les opérations autorisées. Le serveur établit l'identité, décide de l'approbation et contrôle les droits.

Ce document sert de contrat commun avant toute implémentation du parcours complet. Les noms de routes et structures marqués **proposés** sont des contrats à confirmer, pas des endpoints réputés existants.

## 2. Acteurs et responsabilités

### 2.1 Electron

Electron est responsable de :
- conserver les données métier locales et leur rattachement immuable au tenant ;
- protéger localement les secrets avec le mécanisme de stockage sécurisé du système ;
- présenter l'état d'activation et les erreurs compréhensibles ;
- gérer les opérations locales explicitement autorisées hors ligne ;
- reprendre une activation interrompue sans créer une nouvelle identité à chaque redémarrage ;
- appliquer les décisions serveur reçues et vérifiées ;
- bloquer toute synchronisation tant que l'approbation serveur valide n'est pas établie.

Electron n'est pas autorisé à :
- décider qu'un terminal est approuvé ;
- considérer la simple présence ou le décodage d'un JWT comme une preuve de validité ;
- choisir ou modifier librement le tenant ;
- transformer un timeout ou une erreur réseau en refus définitif ;
- effacer automatiquement les données locales à la suite d'un refus, d'une révocation ou d'un changement de compte.

### 2.2 API Sync Engine

L'API est responsable de :
- consommer de manière atomique les codes d'activation à usage unique ;
- créer et rattacher l'enregistrement serveur du terminal ;
- associer le terminal à un tenant, et, si applicable, à un magasin, un profil POS et un agent ;
- vérifier les jetons présentés et leurs autorisations à chaque requête protégée ;
- décider et exposer l'état d'approbation du terminal ;
- contrôler l'accès à chaque opération de synchronisation ;
- gérer suspension, révocation, réactivation et audit ;
- empêcher qu'un terminal ou un client choisisse un tenant non autorisé.

L'API est la source de vérité pour l'approbation et l'autorisation. Une valeur locale ou un claim non vérifié ne peut pas remplacer sa décision.

### 2.3 Fournisseur d'identité (IdP)

L'IdP est responsable de :
- authentifier l'utilisateur ou l'agent selon la politique retenue ;
- émettre les jetons attendus par l'API ;
- signer les jetons et publier les clés de validation via JWKS ;
- gérer les durées de vie, renouvellements, rotation et révocation selon ses capacités ;
- fournir un issuer et une audience stables et documentés.

L'IdP ne remplace pas le registre des terminaux de l'API : être authentifié comme utilisateur ne signifie pas qu'un terminal donné est approuvé.

## 3. Identifiants et provenance de confiance

| Identifiant | Signification | Source de confiance / règle |
|---|---|---|
| `tenantId` | Entreprise propriétaire du contexte | Déterminé par l'API à partir du code d'activation et des droits authentifiés ; confirmé par une réponse serveur authentifiée |
| `deviceId` | Identité serveur du terminal | Créé par l'API lors de l'activation ; jamais inventé par Electron |
| `agentId` | Utilisateur/agent authentifié | Claim validé par l'API ou identité résolue côté serveur auprès de l'IdP |
| `issuer` (`iss`) | Autorité ayant émis le jeton | Claim JWT validé et comparé à la liste d'issuers autorisés |
| `audience` (`aud`) | Destinataire du jeton | Claim JWT validé et comparé à l'audience attendue par l'API |
| empreinte matérielle | Indice de reconnaissance du terminal | Donnée déclarative fournie par le client ; jamais un secret ni une preuve d'identité à elle seule |
| `activationCode` | Autorisation initiale d'appairage | Secret temporaire, à usage unique, généré et contrôlé côté serveur |

### 3.1 Règles de validation des jetons

L'API doit vérifier cryptographiquement la signature à partir des clés JWKS de l'issuer attendu, ainsi que :
- l'algorithme autorisé (liste explicite, jamais `none`) ;
- `iss`, `aud`, `exp` et, si applicable, `nbf` ;
- la présence et la cohérence des claims d'identité requis ;
- les droits de l'agent et l'état courant du terminal ;
- la correspondance entre `deviceId`, `tenantId` et le registre serveur.

Le client peut décoder certains claims pour afficher un état ou vérifier une cohérence locale. Ce décodage n'est pas une validation cryptographique. La signature présente, les segments JWT bien formés ou un claim `tenantId` lisible ne prouvent ni l'authenticité du jeton ni l'approbation du terminal.

### 3.2 Liaison locale

La base SQLite liée à un tenant ne peut pas être réaffectée silencieusement à un autre tenant. Une divergence doit bloquer l'accès réseau protégé et déclencher un parcours explicite de résolution. Aucune suppression ou réinitialisation automatique des données n'est permise.

La liaison SQLite protège la continuité locale ; elle ne constitue pas une preuve d'approbation serveur.

## 4. Machine à états du terminal

États normatifs :

- `UNBOUND` : aucune identité de terminal ni liaison de tenant établie localement.
- `LOCAL_REGISTERED` : contexte local préparé et informations nécessaires à l'activation conservées ; aucune approbation serveur.
- `PENDING_ACTIVATION` : demande d'activation envoyée ou en cours de vérification par le serveur.
- `SERVER_APPROVED` : décision positive explicite, authentifiée et encore valide.
- `SERVER_REJECTED` : refus explicite du serveur ; état bloquant jusqu'à une action administrative ou un nouveau parcours autorisé.
- `RETRY_REQUIRED` : activation non résolue pour une raison transitoire ; une reprise est possible.

Transitions autorisées :

```text
UNBOUND
  -> LOCAL_REGISTERED
  -> PENDING_ACTIVATION
       -> SERVER_APPROVED
       -> SERVER_REJECTED
       -> RETRY_REQUIRED
            -> PENDING_ACTIVATION
SERVER_APPROVED
  -> PENDING_ACTIVATION (renouvellement/réévaluation explicitement requis)
  -> SERVER_REJECTED ou état révoqué (décision serveur)
```

Une transition vers `SERVER_APPROVED` exige une preuve serveur explicite, liée au terminal et au tenant. Un HTTP 200 générique, une réponse de création de terminal, un premier pull réussi ou la seule présence d'un JWT ne suffisent pas.

Une panne réseau, un timeout, une indisponibilité de l'IdP ou une erreur 5xx conduit à `RETRY_REQUIRED`, jamais à `SERVER_REJECTED`.

### 4.1 Règles d'accès par état

| État | Données locales | Synchronisation | Opérations distantes |
|---|---|---|---|
| `UNBOUND` | Initialisation uniquement | Interdite | Activation uniquement |
| `LOCAL_REGISTERED` | Préparation locale autorisée | Interdite | Activation uniquement |
| `PENDING_ACTIVATION` | Conservation ; opérations hors ligne limitées par politique produit | Interdite | Vérification d'activation uniquement |
| `RETRY_REQUIRED` | Conservation ; opérations hors ligne limitées par politique produit | Interdite | Reprise d'activation uniquement |
| `SERVER_APPROVED` | Accès selon droits et politique hors ligne | Autorisée après contrôle serveur | Selon autorisations |
| `SERVER_REJECTED` | Conservation et consultation/export selon politique de sécurité | Interdite | Parcours de résolution autorisé uniquement |

La liste précise des opérations métier hors ligne autorisées pendant l'attente ou après révocation doit être validée par le produit et la gouvernance métier. Elle ne doit pas être implicite.

## 5. Contrats d'échange API

Les contrats ci-dessous sont **proposés** et doivent être rapprochés des contrôleurs, DTO et services existants avant implémentation.

### 5.1 Activation initiale

Le client transmet le code d'activation et les métadonnées du terminal à l'API. Le code est à usage unique et doit être consommé atomiquement.

Exemple de requête proposée :

```http
POST /api/v1/devices/enroll
Content-Type: application/json
X-Device-Fingerprint: <identifiant-declaratif>
```

```json
{
  "activationCode": "<secret-temporaire>",
  "deviceName": "Caisse principale",
  "hardwareInfo": {}
}
```

La réponse de création d'un enregistrement de terminal ne doit pas être interprétée automatiquement comme une approbation opérationnelle. Le serveur doit indiquer explicitement si l'activation est en attente ou approuvée, et fournir un identifiant de suivi.

Le code d'activation :
- doit être imprévisible, limité dans le temps et à usage unique ;
- doit être stocké sous forme protégée côté serveur ;
- doit être consommé dans une transaction garantissant l'absence de double utilisation concurrente ;
- ne doit jamais être journalisé en clair ;
- ne doit pas être réutilisable après succès ou expiration.

### 5.2 Vérification de l'état

Contrat proposé : une opération authentifiée permet au client de demander l'état courant de son terminal. L'API détermine le terminal à partir du contexte authentifié et vérifie que le jeton, le tenant et le registre du terminal concordent.

La réponse doit contenir au minimum :
- `deviceId` ;
- `tenantId` ;
- état serveur (`pending`, `approved`, `rejected`, `revoked` ou équivalent documenté) ;
- date de décision ou de dernière vérification ;
- éventuelle raison de refus sous forme non sensible ;
- version du contrat et, si nécessaire, échéance de validité de l'approbation.

Le client ne doit pas pouvoir demander l'état d'un terminal arbitraire en fournissant simplement un `deviceId` non autorisé.

### 5.3 Preuve d'approbation

La réponse d'approbation doit être authentifiée par le canal TLS et être liée au contexte authentifié. Si une preuve portable ou persistante est nécessaire, elle doit être signée par le serveur ou représentée par un jeton serveur vérifiable, avec au minimum :
- `deviceId` ;
- `tenantId` ;
- statut d'approbation ;
- issuer et audience attendus ;
- date d'émission et échéance ;
- identifiant/version de décision permettant de détecter une ancienne approbation.

Un booléen envoyé par le client, un champ local modifiable ou un claim non validé ne constitue pas une preuve.

### 5.4 Synchronisation

Chaque endpoint de synchronisation protégé doit :
1. authentifier le jeton ;
2. valider issuer, audience, signature et temporalité ;
3. identifier l'agent et le terminal ;
4. vérifier côté serveur que le terminal est approuvé et non révoqué ;
5. vérifier que le terminal appartient au tenant du contexte autorisé ;
6. appliquer les autorisations métier et l'isolation multi-tenant ;
7. refuser par défaut en cas d'identité ambiguë ou de statut inconnu.

Le client ne doit pas lancer de synchronisation tant que son état local n'est pas `SERVER_APPROVED`. Cette règle côté client améliore la cohérence UX, mais le contrôle serveur demeure obligatoire et non contournable.

## 6. Invariants de sécurité

1. **Origine du tenant :** un tenant ne peut jamais être déduit d'une simple saisie utilisateur ni choisi librement par Electron.
2. **Approbation préalable :** un terminal non approuvé ne synchronise jamais.
3. **Panne ≠ refus :** une panne réseau ou technique n'est jamais assimilée à un refus explicite.
4. **Autorité serveur :** le serveur reste la source de vérité pour l'approbation, les droits et la révocation.
5. **Conservation locale :** l'état et les données locales sont conservés tant qu'une politique explicite et une décision autorisée ne justifient pas une action différente.
6. **Liaison immuable :** une base SQLite liée à un tenant ne change pas de tenant par simple remplacement de jeton.
7. **Identité cohérente :** `deviceId`, `tenantId` et `agentId` sont vérifiés ensemble côté serveur.
8. **Aucun secret déclaratif :** empreinte matérielle, nom d'appareil et métadonnées ne sont pas des credentials.
9. **Échec fermé :** toute incohérence d'identité, de tenant, de signature ou d'état bloque les opérations distantes protégées.
10. **Idempotence :** la répétition d'une activation ou d'une demande de vérification ne crée pas plusieurs identités serveur pour le même processus d'activation.
11. **Pas de confiance dans le seul client :** aucun contrôle de sécurité essentiel ne dépend exclusivement d'une vérification Electron.
12. **Traçabilité :** les décisions d'activation, d'approbation, de refus et de révocation sont auditables sans exposer les secrets.

## 7. Reprise après incident

| Incident | État attendu | Comportement |
|---|---|---|
| Perte réseau avant envoi | `RETRY_REQUIRED` ou état local précédent | Conserver la demande et réessayer |
| Timeout après envoi, résultat inconnu | `RETRY_REQUIRED` | Interroger l'état ou rejouer de manière idempotente ; ne pas générer une nouvelle identité |
| Réponse 5xx / IdP indisponible | `RETRY_REQUIRED` | Reprise avec temporisation ; aucun refus implicite |
| Code d'activation expiré | `SERVER_REJECTED` ou code métier distinct | Demander une nouvelle activation autorisée ; ne pas effacer SQLite |
| Jeton expiré | État d'authentification à renouveler | Renouveler via l'IdP ; ne pas confondre expiration et révocation du terminal |
| Jeton invalide ou mauvais issuer/audience | Accès distant bloqué | Erreur d'authentification ; conserver les données locales |
| Redémarrage pendant activation | Restaurer l'état durable | Reprendre la vérification sans perdre le contexte |
| Réponse d'état contradictoire | Accès distant bloqué | Journaliser l'anomalie et demander une vérification serveur |

Les tentatives doivent être idempotentes et bornées par une stratégie de reprise avec temporisation. Les secrets temporaires ne doivent pas être conservés au-delà de leur nécessité et ne doivent jamais être écrits dans les logs.

## 8. Révocation

La révocation est une décision serveur explicite. Elle doit :
- être persistée dans le registre des terminaux ;
- empêcher immédiatement les nouvelles opérations protégées dès que l'API constate le statut ;
- invalider ou rendre inutilisables les moyens d'accès associés au terminal selon le modèle de jetons retenu ;
- être propagée au client lors de sa prochaine communication ;
- produire un événement d'audit horodaté et attribué à un acteur autorisé.

Le client hors ligne ne peut pas connaître instantanément une révocation. Le risque résiduel doit être réduit par des jetons de courte durée, une politique de renouvellement et un contrôle serveur à chaque opération. La durée maximale d'utilisation hors ligne après dernière approbation doit être décidée explicitement ; aucune durée ne doit être supposée dans le code.

Après révocation :
- la synchronisation est bloquée ;
- les données locales ne sont pas effacées automatiquement ;
- les opérations locales permises, l'export, la réactivation et le transfert de données suivent une politique produit/sécurité documentée ;
- une réactivation nécessite une décision serveur nouvelle, pas la réutilisation d'une ancienne preuve.

## 9. Journalisation et audit

Événements minimaux :
- demande d'activation reçue ;
- code d'activation accepté, expiré, invalide ou déjà consommé ;
- terminal créé et rattachement tenant établi ;
- activation en attente ;
- approbation ou refus explicite ;
- renouvellement d'identité ou de preuve ;
- divergence tenant/terminal ;
- synchronisation refusée pour statut non approuvé ou révoqué ;
- révocation, réactivation et acteur décisionnaire ;
- reprises après incident et résultats.

Chaque événement doit inclure un identifiant de corrélation, un horodatage serveur, le type d'événement et les identifiants nécessaires (`tenantId`, `deviceId`, `agentId` lorsqu'ils sont connus). Ne jamais journaliser activationCode, JWT, refresh token, clé privée, secret ou données personnelles non nécessaires.

## 10. Tests d'intégration obligatoires

Les tests doivent couvrir au minimum :

1. **Activation nominale :** code valide, terminal créé une seule fois, identité et tenant cohérents, approbation explicite.
2. **Refus explicite :** état refusé, synchronisation bloquée, données locales conservées.
3. **Perte réseau pendant activation :** état récupérable, aucune fausse approbation ni faux refus.
4. **Reprise après redémarrage :** restauration de l'état durable et reprise idempotente.
5. **Révocation serveur :** opérations distantes refusées après révocation ; client mis à jour au prochain contact.
6. **Changement de tenant :** jeton d'un autre tenant rejeté ; aucune réaffectation ou suppression SQLite.
7. **Réinstallation du terminal :** comportement documenté selon présence/absence de données locales et procédure de réactivation.
8. **Synchronisation avant approbation :** refus côté client et côté serveur.
9. **Synchronisation après approbation :** succès uniquement avec jeton valide, bon terminal, bon tenant et droits suffisants.
10. **Code d'activation concurrent :** une seule consommation et une seule identité créée.
11. **JWT invalide :** signature, issuer, audience, expiration ou claims incorrects rejetés.
12. **Usurpation d'identifiants :** un agent ne peut pas substituer un `deviceId` ou `tenantId` arbitraire.
13. **Idempotence :** répétition de la même demande après timeout ne crée pas de doublon.
14. **Échec IdP/JWKS :** comportement fermé et récupérable, sans approbation locale.
15. **Isolation multi-tenant :** aucun accès croisé par les endpoints d'activation, de statut ou de synchronisation.

Les tests doivent inclure des cas d'intégration API + PostgreSQL + client Electron/SQLite, pas uniquement des tests unitaires de parsing JWT ou de stockage local.

## 11. Parcours de référence et autorité décisionnelle

| Étape | Action | Qui décide ? | Preuve attendue |
|---|---|---|---|
| 1. Nouvel ordinateur | Installation et initialisation locale | Electron pour l'initialisation uniquement | Base locale initialisée, aucun statut approuvé |
| 2. Code d'activation | Saisie puis transmission du code | L'opérateur fournit le code ; l'API en vérifie la validité | Réponse API corrélée à la demande |
| 3. Création du terminal | Consommation atomique du code et création du registre | API | `deviceId` et `tenantId` attribués côté serveur |
| 4. Authentification | Connexion de l'agent et émission du jeton | IdP | JWT signé avec issuer/audience attendus |
| 5. Premier démarrage | Restauration du jeton et de l'état local | Electron applique les règles ; ne décide pas de l'approbation | État local non approuvé tant que le serveur n'a pas confirmé |
| 6. Vérification serveur | Vérification identité, terminal, tenant et statut | API, avec validation JWT selon l'IdP | Réponse explicite liée au `deviceId` et au `tenantId` |
| 7. Premier sync | Synchronisation des données autorisées | API autorise ou refuse ; Electron ne l'initie qu'après approbation | Requête authentifiée et contrôle serveur réussi |
| 8. Vie du terminal | Renouvellement, contrôle et révocation | IdP pour les jetons ; API pour l'approbation du terminal | État serveur courant et événements d'audit |

### Questions à trancher avant implémentation

- Le code d'activation crée-t-il un terminal immédiatement approuvé, ou un terminal en attente d'approbation humaine/administrative ?
- Quel acteur est autorisé à approuver ou refuser un terminal ?
- Quel est le lien exact entre l'agent authentifié par l'IdP et le terminal créé par le code d'activation ?
- L'IdP émet-il un jeton contenant un identifiant de terminal, ou l'API établit-elle cette liaison dans son propre registre ?
- Quel mécanisme de preuve d'approbation est retenu : réponse API authentifiée et revalidation périodique, ou jeton d'approbation signé à durée limitée ?
- Quelle durée hors ligne est tolérée après la dernière approbation valide ?
- Quelles opérations métier restent permises pendant `PENDING_ACTIVATION`, `RETRY_REQUIRED` et après révocation ?
- Quelle est la procédure contrôlée de réinstallation, remplacement matériel et transfert d'un terminal ?

Aucune de ces décisions ne doit être inventée dans l'implémentation. Elles doivent être arbitrées et consignées.

## 12. Critères Go / No-Go avant généralisation

Le déploiement généralisé est **NO-GO** tant que toutes les conditions suivantes ne sont pas démontrées :

- [ ] Le parcours nominal d'activation est testé de bout en bout.
- [ ] Le refus explicite bloque la synchronisation sans perte de données locales.
- [ ] La perte réseau et les timeouts conduisent à une reprise, jamais à une approbation implicite.
- [ ] L'état d'activation survit au redémarrage.
- [ ] La révocation est appliquée côté API et propagée au client.
- [ ] Un changement de tenant ne peut pas réaffecter une base SQLite liée.
- [ ] La réinstallation et le remplacement d'un terminal ont une procédure vérifiée.
- [ ] Toute synchronisation avant approbation est refusée côté serveur.
- [ ] La synchronisation après approbation valide fonctionne avec les contrôles d'identité complets.
- [ ] Les contrôles de signature, issuer, audience, expiration et autorisations sont testés.
- [ ] Les scénarios concurrents et les répétitions après timeout sont idempotents.
- [ ] Les logs permettent l'audit sans divulguer de secrets.
- [ ] Les tests multi-tenant démontrent l'absence d'accès croisé.
- [ ] Les questions d'architecture de la section 11 ont reçu une décision documentée.
- [ ] La documentation correspond au comportement réel du code et aux contrats de l'IdP.

Des pipelines CI verts sont nécessaires, mais ne suffisent pas à eux seuls à autoriser une généralisation.

## 13. État de l'existant et limites de ce document

Au moment de la rédaction, le parcours serveur documenté comprend un endpoint d'enrôlement qui consomme un code d'appairage et crée un enregistrement de terminal. Cet endpoint ne délivre pas lui-même de JWT. Le parcours Electron examiné séparément accepte un JWT, vérifie sa structure et ses claims côté client, lie la base SQLite au tenant extrait, puis peut démarrer une synchronisation asynchrone.

Ces deux mécanismes ne démontrent pas à eux seuls un cycle commun d'approbation serveur. En particulier :
- le décodage local d'un JWT ne valide pas sa signature ;
- le rattachement SQLite au tenant ne prouve pas l'approbation du terminal ;
- la création serveur d'un terminal ne prouve pas qu'Electron a vérifié et appliqué son statut ;
- le déclenchement d'une synchronisation asynchrone ne constitue pas une approbation.

Le travail de conception suivant consiste à comparer ce contrat aux contrôleurs, services, DTO, middlewares d'authentification et parcours Electron réellement présents, puis à consigner les écarts avant toute modification fonctionnelle.

## 14. Ordre de mise en œuvre

1. Valider les décisions ouvertes de la section 11 avec les responsables produit, API et identité.
2. Tracer le parcours réel dans le code et compléter la matrice « prévu / existant / écart ».
3. Définir les DTO et réponses API définitifs, ainsi que le mécanisme de preuve d'approbation.
4. Implémenter sur une branche dédiée, sans modifier implicitement le périmètre de la PR de liaison SQLite.
5. Ajouter les tests d'intégration obligatoires et les scénarios de panne/révocation.
6. Auditer les résultats, la documentation et les pipelines.
7. Prendre séparément la décision de fusion des PR concernées et la décision Go/No-Go de déploiement.

**Principe final :** l'identité du terminal est une relation gouvernée par le serveur et vérifiée à chaque opération protégée ; SQLite en conserve une représentation locale cohérente, mais ne la crée ni ne l'approuve.
