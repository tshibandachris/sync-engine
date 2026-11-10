# Isolation PostgreSQL de l'enrôlement des terminaux

## Principe

L'enrôlement initial est la seule opération backend qui utilise une connexion PostgreSQL dédiée. La connexion générale (`DATABASE_URL`) reste affectée aux opérations applicatives et de synchronisation. Elle ne reçoit aucun droit `EXECUTE` sur `public.register_device_enrollment_with_credential(...)`, aucun droit d'écriture sur `devices`, aucun accès aux codes d'activation et aucun droit d'exécution sur les deux helpers SECURITY DEFINER historiques.

La migration `036_device_enrollment_executor_role.sql` retire aussi à `sync_app` les privilèges historiques d'insertion de devices, de lecture/consommation des codes d'activation et d'appel direct aux helpers. Le trigger pending-only reste une défense en profondeur, mais la connexion générale n'a plus le droit d'insérer un device. Elle conserve les lectures nécessaires au contrôle d'approbation et à la preuve de terminal.

La migration crée (ou valide) le rôle-capacité `device_enrollment_executor` avec les attributs suivants : `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`. Elle révoque le privilège de la fonction d'enrôlement à `PUBLIC` et `sync_app`, puis le donne uniquement à ce rôle.

La migration ne crée jamais de compte LOGIN et ne stocke aucun secret.

## Provisionnement du compte dédié

Dans le déploiement Docker Compose fourni, `scripts/migrate.sh` applique les migrations en attente via `schema_migrations`, puis crée ou fait tourner le login `device_enrollment_login` à partir du secret `DEVICE_ENROLLMENT_PASSWORD`. Il révoque toute appartenance à `sync_app`, lui accorde `device_enrollment_executor`, et vérifie les privilèges effectifs avant de terminer. `docker-compose.prod.yml` construit ensuite `DEVICE_ENROLLMENT_DATABASE_URL` à partir de ce même secret.

Pour un cluster géré ou un déploiement où le compte de migration n'a pas `CREATEROLE`, le DBA doit pré-provisionner le rôle-capacité et le login dédiés :

```sql
CREATE ROLE device_enrollment_login
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD '<secret-fourni-par-le-gestionnaire-de-secrets>';

GRANT device_enrollment_executor TO device_enrollment_login;
```

Ne jamais accorder `sync_app` à `device_enrollment_login`, ni accorder `device_enrollment_executor` au compte de synchronisation. Le compte dédié ne doit pas être propriétaire des tables ou de la fonction, ni superutilisateur.

Pour le mode Docker Compose local, copier `.env.example` vers `.env`, remplacer les trois secrets et conserver le hostname `db` dans les deux URLs (le hostname `localhost` ne fonctionne pas depuis le conteneur API). Le job `migrate` crée les deux logins ; le service API ne démarre qu'après son succès.

Configurer les secrets de l'application :

- `POSTGRES_PASSWORD` : mot de passe PostgreSQL utilisé par le service DB ;
- `SYNC_APP_PASSWORD` : mot de passe du login applicatif `sync_app` ;
- `DEVICE_ENROLLMENT_PASSWORD` : secret aléatoire fort utilisé par le job de migration pour créer/faire tourner le login dédié ;
- `DATABASE_URL` : connexion applicative habituelle, avec le même mot de passe que `SYNC_APP_PASSWORD` ;
- `DEVICE_ENROLLMENT_DATABASE_URL` : connexion du compte `device_enrollment_login`.

Au démarrage, le backend vérifie l'identité réelle de la seconde connexion : `session_user`, absence de superuser, BYPASSRLS, CREATEROLE, CREATEDB et REPLICATION, rôle LOGIN en mode INHERIT, absence d'appartenance à `sync_app`, appartenance effective à `device_enrollment_executor` et privilège `EXECUTE` sur la signature exacte de la fonction. Une configuration invalide arrête le démarrage (fail closed).

## Migration ledger et bases existantes

Le script de déploiement ne se contente plus de tester la présence de `check_ins` : il suit chaque fichier dans `schema_migrations` et applique uniquement les migrations absentes. Pour une ancienne base sans ledger, il vérifie le jalon historique pré-031 (tables `devices` et `device_pairing_codes`, sans `device_credentials`) avant de marquer 001–030 comme déjà appliquées. Si cette empreinte ne correspond pas, il s'arrête plutôt que de deviner l'état du schéma.

Si le compte de migration n'a pas `CREATEROLE`, un DBA doit pré-provisionner `device_enrollment_executor` avec exactement les attributs ci-dessus avant d'exécuter la migration 036, puis créer le login dédié, lui accorder l'appartenance au rôle et le connecter à `DEVICE_ENROLLMENT_DATABASE_URL`. La migration valide les attributs et échoue explicitement si le rôle-capacité existant est plus permissif.

## Frontière de confiance

- Le service NestJS valide la preuve initiale ES256 avant tout appel SQL.
- Le pool dédié ne peut appeler que les opérations explicitement accordées à son rôle, notamment la fonction atomique d'enrôlement.
- La fonction SECURITY DEFINER conserve l'atomicité de consommation du code, création du terminal pending, credential, événement d'audit, nonce et reçu d'idempotence.
- L'approbation reste une décision serveur distincte ; ce privilège ne permet pas d'approuver un terminal.
- Le pool général continue de porter les routes métier et la synchronisation en lecture/écriture sur leurs domaines autorisés ; il ne peut ni créer un terminal, ni consommer un code d'activation, ni écrire credential/événement d'approbation. Aucun changement n'est apporté à l'Outbox Electron.

Le succès des tests de privilèges prouve la séparation dans la base de test. Il ne dispense pas de vérifier les rôles, secrets et memberships du cluster de production après déploiement.
