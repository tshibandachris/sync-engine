# Contrat d’activation et d’autorisation du terminal

## Principe d’autorité

L’état de confiance du terminal est déterminé par le serveur. Une session agent authentifiée, une clé locale ou une indisponibilité réseau ne valent jamais approbation.

Un terminal en état `SERVER_REJECTED` ou `REVOKED` peut consulter les données locales existantes, mais ne peut créer, modifier ou synchroniser aucune donnée métier. Cette règle est imposée dans le processus principal Electron sur chaque canal IPC concerné ; le masquage ou la désactivation des commandes dans le renderer n’est qu’une mesure d’ergonomie.

## Matrice d’accès

| État fonctionnel | Lecture locale | Écriture métier | Synchronisation |
| --- | --- | --- | --- |
| `UNBOUND` / `unregistered` | Non | Non | Non |
| `LOCAL_REGISTERED` / `awaiting_approval` | Consultation limitée | Non | Non |
| `PENDING_ACTIVATION` / `awaiting_approval` | Consultation limitée | Non | Non |
| `RETRY_REQUIRED` après approbation | Oui | Oui | En attente / réessai |
| `SERVER_APPROVED` / `approved` | Oui | Oui | Oui si la credential ES256 est active |
| `SERVER_REJECTED` / `rejected` | Oui, lecture seule | Non | Non |
| `REVOKED` / `revoked` | Oui, lecture seule | Non | Non |
| Terminal désactivé / `deactivated` | Oui, lecture seule | Non | Non |

Les noms fonctionnels historiques sont des libellés de parcours. Les valeurs internes de confiance restent celles de `electron/auth/device-state.cjs`. `RETRY_REQUIRED` est un état opérationnel transitoire : une erreur réseau, API ou timeout ne remplace pas une décision de confiance déjà confirmée. Si le terminal était approuvé, les opérations locales restent possibles et l’outbox conserve les éléments en attente. Une erreur réseau ne transforme jamais un terminal non approuvé en terminal approuvé.

## Règles de lecture seule

Après `SERVER_REJECTED` ou `REVOKED`, sont autorisés :
- la consultation des données locales déjà présentes ;
- la consultation des rapports et historiques déjà synchronisés ou conservés localement ;
- les opérations de diagnostic et d’audit en lecture seule ;
- l’export ou la sauvegarde, lorsqu’une fonction dédiée est disponible ;
- la régularisation administrative hors des opérations métier du terminal.

Sont interdits :
- les nouvelles ventes et ouvertures de caisse ;
- les demandes de clôture qui modifient l’état métier ;
- les créations ou modifications de produits et de stock ;
- toute autre écriture métier locale ;
- toute synchronisation, émission de preuve métier ou exécution distante.

Aucune donnée locale, aucun élément d’outbox et aucune trace d’audit ne sont supprimés à la suite d’un rejet ou d’une révocation. Le blocage des écritures ne doit pas empêcher la sauvegarde ou l’analyse des éléments déjà présents.

## Application technique

- `canReadLocalData` autorise la consultation uniquement pour une session agent authentifiée et un terminal enregistré ou précédemment connu.
- `canAccessLocalPOS` autorise les écritures métier uniquement lorsque le serveur a confirmé `approved`.
- `canRunSync` exige l’approbation, une session agent authentifiée, une preuve ES256 locale et une credential serveur active.
- Les handlers IPC de lecture et d’écriture appliquent chacun leur contrôle dans le processus principal.
- Le renderer reflète les capacités reçues du processus principal, sans être considéré comme une frontière de sécurité.
- Une réponse serveur `rejected`, `revoked` ou `deactivated` reste bloquante jusqu’à une nouvelle décision serveur valide.

## Scénarios E2E supplémentaires obligatoires

Ces trois scénarios complètent les dix scénarios de la matrice E2E Eden Gestion v1.0. L’acceptation fonctionnelle exige désormais **13 scénarios sur 13 PASS**.

### E2E-03A — Vente refusée après rejet
1. Obtenir l’état serveur `rejected`.
2. Tenter une vente par l’interface puis appeler directement le canal IPC de création de vente.
3. Vérifier le refus dans les deux cas.
4. Vérifier qu’aucune vente, ligne, écriture de stock ou entrée d’outbox supplémentaire n’a été créée.

### E2E-04A — Ouverture de caisse refusée après révocation
1. Partir d’un terminal précédemment approuvé.
2. Obtenir la décision serveur `revoked`.
3. Tenter l’ouverture d’une nouvelle session, y compris par appel IPC direct.
4. Vérifier le refus et l’absence de nouvelle session ou d’entrée d’outbox.

### E2E-04B — Consultation autorisée après révocation
1. Partir d’un terminal révoqué contenant des données locales préexistantes.
2. Consulter le tableau de bord, le catalogue et les historiques disponibles.
3. Vérifier que les données sont accessibles sans modification.
4. Vérifier que les commandes de création, modification et synchronisation restent refusées.

## Hors périmètre de ce contrat

Ce contrat ne vaut ni autorisation de fusion, ni autorisation de déploiement, ni autorisation d’exécuter des migrations réelles. Il ne définit pas non plus une procédure automatique de ré-enrôlement d’un terminal rejeté ou révoqué.
