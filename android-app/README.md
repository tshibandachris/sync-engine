# Eden Gestion Android — spike 0

Client Capacitor isolé dans `android-app/`, sans modification du client Electron. Cette branche est créée depuis `main`, sans dépendance à la PR #93 ni à `feat/multicurrency-server-ledger`.

## Versions épinglées

- Capacitor Core / Android / CLI : 8.6.0 (stable au démarrage de la tranche).
- `@capacitor-community/sqlite` : 8.1.1.
- SQLite est natif sur Android ; aucune donnée métier ne doit être stockée dans localStorage, IndexedDB ou les cookies.
- Les versions sont exactes dans `package.json`. Le lockfile npm sera généré par npm lors de l'installation/CI.

Références de versions : npm `@capacitor/core` 8.6.0 et `@capacitor/android` 8.6.0 ; npm `@capacitor-community/sqlite` 8.1.1.

## Spike obligatoire avant les écrans métier

1. Installer et lancer l'APK debug sur Android 13.
2. Écrire la ligne de test SQLite, redémarrer réellement la tablette, activer le mode avion, relancer et relire la ligne.
3. Générer une clé P-256 non exportable dans Android Keystore, signer un challenge ES256, redémarrer et vérifier que la même clé publique signe encore.
4. Vérifier que l'application reste utilisable lorsque l'optimisation de batterie est désactivée.

### Décision de conception pour le test de clé

Le spike privilégie **la signature native par Android Keystore** : la clé privée reste non exportable dans le Keystore, et le pont Capacitor ne retourne que la clé publique SPKI PEM et une signature ES256 IEEE P1363 (64 octets). Cela évite de transporter une clé privée dans un coffre générique. La comparaison avec une clé exportable chiffrée dans le stockage sécurisé est documentée comme solution de repli, mais elle n'est pas retenue sans preuve qu'elle apporte un avantage.

Le code Java du plugin natif et son raccordement à MainActivity sont le prochain sous-livrable du spike. Aucun écran métier ni synchronisation ne doit être déclaré prêt avant les tests sur appareil.

## Blocage serveur identifié

Sur `main`, `POST /api/v1/devices/enroll` consomme le code et crée le terminal, mais ne délivre pas de JWT. La documentation `docs/device-enrollment.md` dit explicitement que l'authentification de production dépend d'un émetteur JWKS externe. La preuve initiale ES256 et la preuve des routes synchronisées existent sur la branche de la PR #93, mais cette branche n'est pas la base de ce client.

Conséquence : un test local de signature n'est pas une preuve d'enrôlement de bout en bout. Le point 3 du spike reste **non validé** tant qu'un environnement serveur ne peut pas vérifier la preuve initiale et établir le lien entre clé publique, terminal et authentification autorisée. Si ce point échoue sur Android, on s'arrête ici.

## Hors périmètre

Ventes, paiements, clôture de caisse, ticket, impression, administration, identité, mouvements de stock et toute synchronisation métier ne sont pas inclus dans le spike 0.
