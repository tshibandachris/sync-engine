# Spécification technique — Packaging Electron et stockage des secrets

- **Projet :** Eden Bureau (application Electron)
- **Branche de travail :** `docs/electron-packaging-spec`
- **Statut :** spécification de préparation à la production — à valider avant publication
- **Cible prioritaire :** Windows x64
- **Références du dépôt au moment de la rédaction :** Electron 38.2.0, Node.js 24.19.0, ABI Node 137, `better-sqlite3` 12.2.0. Vérifier ces versions dans les manifestes et le lockfile avant chaque release.

## 1. Objectifs et principes

Le paquet livré doit démarrer sur une machine propre, fonctionner sans installation de Node.js par l'utilisateur, conserver la base SQLite locale et sa file d'attente durable, et ne jamais dépendre d'un secret injecté manuellement dans l'environnement de l'utilisateur.

Principes obligatoires :

1. versions Node, Electron, dépendances natives et lockfile cohérentes et reproductibles ;
2. compilation et validation du module natif pour la version exacte d'Electron ciblée ;
3. séparation du code applicatif, des données utilisateur et des secrets ;
4. construction sur des runners adaptés à chaque système cible, artefacts identifiés par version, architecture et commit ;
5. aucune publication si les tests de démarrage, de persistance et de synchronisation échouent.

Cette spécification décrit la cible de packaging. Elle ne signifie pas que tous les artefacts ou mécanismes de sécurité sont déjà implémentés.

## 2. Prérequis de build multi-plateforme

### 2.1 Environnement reproductible

- Utiliser une version LTS/supportée de Node.js compatible avec le projet, fixée explicitement dans `.nvmrc`, `engines` et/ou la configuration CI.
- Installer les dépendances avec le gestionnaire du dépôt et le lockfile en mode strict (par exemple `npm ci` si le projet utilise npm).
- Épingler Electron, `electron-builder`, `better-sqlite3` et les autres dépendances natives. Toute mise à niveau d'Electron impose de reconstruire et retester les modules natifs.
- Utiliser des runners CI propres. Ne pas réutiliser un dossier `node_modules` compilé sur un autre OS ou pour une autre version d'Electron.
- Documenter les outils de compilation requis pour les modules natifs : Visual Studio Build Tools/C++ sur Windows, Xcode Command Line Tools sur macOS et toolchain C/C++ appropriée sur Linux lorsque la compilation depuis les sources est nécessaire.

### 2.2 Cibles et runners recommandés

| Cible | Runner recommandé | Artefact envisagé |
|---|---|---|
| Windows x64 (priorité) | Windows x64 | installateur NSIS `.exe` |
| macOS arm64 / x64 (si pris en charge) | runners macOS correspondants | `.dmg` ou `.zip` |
| Linux x64 (si pris en charge) | runner Linux x64 | `.AppImage` ou paquet adapté à la distribution |

Les cibles réellement supportées doivent être déclarées dans la configuration `build` d'`electron-builder`. Un runner natif par OS/architecture est le choix le plus fiable, notamment pour les dépendances natives. Ne pas annoncer macOS ou Linux comme supportés tant que leurs builds et tests ne sont pas passés. La signature et la notarisation macOS, ainsi que la signature Authenticode Windows, sont des étapes de release à prévoir avec des secrets CI dédiés.

### 2.3 Configuration electron-builder

La configuration doit au minimum :

- définir un identifiant d'application stable (`appId`), le nom du produit, la version et les répertoires de sortie ;
- inclure uniquement les fichiers nécessaires à l'exécution (`files`) et exclure les sources, tests, caches, fichiers locaux et secrets ;
- définir explicitement la cible Windows x64 et l'installateur NSIS ;
- traiter les fichiers natifs SQLite avec `asarUnpack` (voir §3) ;
- ne pas embarquer de base de développement, de jeton, de fichier `.env`, de journal ou de données utilisateur ;
- conserver les artefacts de build et leurs sommes de contrôle dans les artefacts CI, avec le SHA du commit et la version.

Exemple indicatif à adapter aux chemins réels du projet :

```json
{
  "build": {
    "appId": "corp.edendevs.edenbureau",
    "productName": "Eden Bureau",
    "asar": true,
    "asarUnpack": [
      "**/*.node"
    ],
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": ["x64"]
        }
      ]
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

Cet exemple est une base de discussion, pas une configuration prête à coller sans vérification : confirmer l'identifiant produit retenu, les scripts existants, les chemins de l'application et les exigences d'installation avant de l'activer.

### 2.4 Scripts et validation de release

Prévoir des scripts clairement séparés, selon le gestionnaire réellement utilisé, pour :

- installation reproductible des dépendances ;
- tests unitaires et tests d'intégration ;
- contrôle TypeScript/lint s'ils sont utilisés par le projet ;
- reconstruction des dépendances natives pour Electron ;
- packaging par OS/architecture ;
- vérification de l'artefact final.

La CI de release doit enregistrer les versions de Node, Electron, electron-builder, l'architecture et l'ABI native. Le pipeline doit échouer si le module SQLite ne se charge pas dans l'application empaquetée. Une simple compilation réussie ne suffit pas.

## 3. Module natif SQLite et ABI Electron

### 3.1 Règle de compatibilité

`better-sqlite3` contient un binaire natif `.node`. Un binaire compilé pour le Node.js système n'est pas nécessairement compatible avec l'ABI utilisée par Electron. L'ABI Node 137 notée dans le dépôt correspond à l'environnement Node indiqué, mais la compatibilité finale doit être vérifiée avec **la version exacte d'Electron** et son runtime embarqué.

Ne jamais copier arbitrairement un binaire natif depuis le poste de développement dans l'artefact de production.

### 3.2 Stratégie de reconstruction

1. Installer les dépendances à partir du lockfile.
2. Reconstruire les dépendances natives pour la version Electron du projet, par exemple via le script `electron-builder install-app-deps` ou l'outil de reconstruction Electron retenu par le dépôt.
3. Exécuter le packaging sur un runner correspondant à l'OS et à l'architecture cible.
4. Vérifier que le module chargé par Electron est bien le binaire construit pour cette cible.
5. Réaliser un test de fumée **depuis l'application empaquetée** : ouvrir la base, créer/lire une transaction de test, fermer proprement, redémarrer et vérifier la persistance.
6. Tester aussi la migration de schéma, l'Outbox hors ligne, la reprise après redémarrage et la synchronisation sans perte ni doublon.

Exemple de séquence indicative, à adapter aux scripts et au gestionnaire du dépôt :

```sh
npm ci
npx electron-builder install-app-deps
npm test
npm run build
npx electron-builder --win nsis --x64
```

Si le dépôt utilise pnpm ou un autre gestionnaire, conserver ce gestionnaire et son lockfile plutôt que d'introduire npm en parallèle. Ne pas lancer la séquence telle quelle avant de confirmer les scripts disponibles.

### 3.3 Inclusion dans le paquet

- Activer `asar` pour les ressources applicatives et extraire les binaires natifs nécessaires via `asarUnpack` (par exemple `**/*.node`).
- Vérifier que les chemins de résolution de `better-sqlite3` fonctionnent dans le paquet installé, pas seulement en mode développement.
- Garder les fichiers de base de données hors de `resources/app.asar` et hors du répertoire d'installation. La base doit résider dans un répertoire de données utilisateur stable, par exemple sous `app.getPath('userData')`.
- Ne jamais remplacer une base utilisateur par une copie embarquée pendant une mise à jour.
- Toute migration doit être versionnée, atomique lorsque possible, testée sur une copie et précédée d'une stratégie de sauvegarde/récupération adaptée aux données comptables.

## 4. Stockage sécurisé des JWT d'appareil

### 4.1 Exigence de sécurité

Les JWT ou jetons de renouvellement persistants ne doivent pas être stockés dans des variables d'environnement, dans le code, dans le dépôt, dans le fichier de configuration de packaging, ni en clair dans un fichier local. Les variables d'environnement conviennent à la configuration de processus et aux secrets CI côté serveur, pas au stockage durable d'un secret d'appareil dans une application de bureau.

### 4.2 Abstraction recommandée

Créer un service de secrets côté processus principal Electron, par exemple `DeviceTokenStore`, fondé sur l'API `safeStorage` d'Electron :

- `safeStorage.encryptString()` pour chiffrer le jeton avant persistance ;
- `safeStorage.decryptString()` pour le relire uniquement lorsqu'il est nécessaire ;
- `safeStorage.isEncryptionAvailable()` et, lorsque disponible dans la version ciblée, `safeStorage.getSelectedStorageBackend()` pour vérifier le backend réel ;
- API limitée : enregistrer, lire, renouveler et supprimer le jeton. Le renderer ne doit jamais recevoir une clé de chiffrement ni accéder directement au fichier de secrets.

Sous Windows, Electron s'appuie normalement sur les mécanismes de protection Windows (DPAPI). Sur macOS et Linux, le backend dépend du système et de la configuration locale ; sous Linux, il peut nécessiter un service de trousseau/secret disponible. La disponibilité de l'API ne signifie pas que le stockage est protégé contre un utilisateur local déjà compromis.

### 4.3 Flux de stockage

1. Le processus principal reçoit le jeton depuis le flux d'authentification HTTPS.
2. Il vérifie que le stockage chiffré est disponible et utilise un backend accepté par la politique de sécurité.
3. Il chiffre le jeton via `safeStorage`.
4. Il persiste uniquement le texte chiffré dans un fichier dédié sous `app.getPath('userData')`, ou dans un stockage applicatif protégé équivalent. Le fichier ne doit pas être placé dans le paquet installé.
5. Il limite les permissions du fichier lorsque le système le permet et effectue les écritures de façon atomique.
6. Au démarrage, il déchiffre le jeton dans le processus principal uniquement lorsqu'une requête authentifiée le nécessite.
7. À la déconnexion, à la révocation ou au changement de compte, il supprime le jeton local et invalide les sessions côté serveur selon le contrat d'authentification.

Si le chiffrement est indisponible ou si le backend n'est pas conforme à la politique, **échouer de manière fermée** : ne pas basculer vers du texte clair ou vers une variable d'environnement. Expliquer à l'utilisateur comment activer le stockage sécurisé du système.

### 4.4 Contrôles complémentaires

- Garder les jetons dans le processus principal ; exposer au renderer uniquement des opérations IPC strictement autorisées via une API `preload` minimale.
- Valider l'origine et le contenu des appels IPC, limiter les canaux et ne jamais exposer un accès IPC générique.
- Utiliser HTTPS avec validation TLS ; ne pas désactiver la vérification des certificats.
- Préférer des jetons d'accès courts et une stratégie de renouvellement/révocation côté serveur. Stocker un jeton de renouvellement seulement si le protocole le nécessite et le protéger de la même façon.
- Ne jamais écrire les jetons, les en-têtes `Authorization`, les valeurs déchiffrées ou les réponses d'authentification sensibles dans les logs, traces, rapports d'erreur ou données analytiques.
- Éviter de conserver les jetons dans `localStorage`, `sessionStorage`, SQLite ou le renderer.
- Prévoir le traitement des erreurs de déchiffrement, de corruption du fichier et de changement de profil OS : réauthentification sûre plutôt que récupération non contrôlée.
- Documenter que le chiffrement lié au compte OS protège principalement les données au repos ; il ne protège pas contre un malware exécuté sous la session utilisateur déverrouillée.

### 4.5 Interface de service — contrat indicatif

```ts
interface DeviceTokenStore {
  isAvailable(): boolean;
  save(token: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
}
```

Le service doit vivre dans le processus principal. Il ne doit pas exposer de méthode permettant au renderer d'exporter la valeur en clair. Les appels IPC éventuels doivent renvoyer un état de succès ou d'erreur, jamais le jeton lui-même.

## 5. Critères d'acceptation avant production

- [ ] Build Windows x64 reproductible sur runner propre.
- [ ] Installateur NSIS testé sur une machine Windows sans Node.js installé.
- [ ] Démarrage de l'application et chargement réussi de `better-sqlite3` dans le paquet final.
- [ ] Persistance SQLite vérifiée après fermeture et redémarrage.
- [ ] Outbox durable : opérations en attente conservées hors ligne et synchronisées sans perte ni doublon.
- [ ] Mise à jour testée sur une installation existante avec données, sans écrasement de la base.
- [ ] Jeton chiffré via le backend sécurisé OS ; aucun jeton en clair dans les fichiers, logs, variables d'environnement ou artefacts.
- [ ] Indisponibilité du backend sécurisé traitée sans fallback en clair.
- [ ] Déconnexion/révocation efface le secret local.
- [ ] Artefact signé si la politique de distribution l'exige, accompagné de son checksum et du SHA source.
- [ ] Les builds et tests requis de la CI sont verts sur le commit de release.

## 6. Décisions à confirmer avant activation

1. Version d'Electron et version de `better-sqlite3` exactes au moment de la release.
2. Gestionnaire de paquets et scripts déjà déclarés dans le dépôt.
3. Identifiant `appId`, stratégie de versionnage et répertoires inclus/exclus.
4. Format de livraison Windows (NSIS recommandé pour cette cible) et nécessité de signature Authenticode.
5. Politique de jetons côté serveur : durée de vie, renouvellement, révocation et liaison à l'appareil.
6. Backend `safeStorage` accepté par OS, avec tests sur les systèmes réellement supportés.

## 7. Références officielles

- Electron `safeStorage`: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron `app.getPath('userData')`: https://www.electronjs.org/docs/latest/api/app
- electron-builder — configuration: https://www.electron.build/configuration
- electron-builder — dépendances natives: https://www.electron.build/
- better-sqlite3 — installation et prérequis: https://github.com/WiseLibs/better-sqlite3

Cette spécification doit être mise à jour lorsque la version d'Electron, le module natif, le protocole d'authentification ou les cibles de distribution changent.
