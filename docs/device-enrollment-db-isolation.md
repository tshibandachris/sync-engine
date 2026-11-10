# Isolation PostgreSQL de l'enrôlement des terminaux

## Principe

L'enrôlement initial est la seule opération backend qui utilise une connexion PostgreSQL dédiée. La connexion générale (`DATABASE_URL`) reste affectée aux opérations applicatives et de synchronisation. Elle ne reçoit aucun droit `EXECUTE` sur `public.register_device_enrollment_with_credential(...)`.

La migration `036_device_enrollment_executor_role.sql` crée (ou valide) le rôle-capacité `device_enrollment_executor` avec les attributs suivants : `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`. Elle révoque le privilège de la fonction d'enrôlement à `PUBLIC` et `sync_app`, puis le donne uniquement à ce rôle.

La migration ne crée jamais de compte LOGIN et ne stocke aucun secret.

## Provisionnement DBA

Après application des migrations 035 et 036, provisionner un compte dédié dans le gestionnaire de secrets de l'environnement :

```sql
CREATE ROLE device_enrollment_login
  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD '<secret-fourni-par-le-gestionnaire-de-secrets>';

GRANT device_enrollment_executor TO device_enrollment_login;
```

Ne jamais accorder `sync_app` à `device_enrollment_login`, ni accorder `device_enrollment_executor` au compte de synchronisation. Le compte dédié ne doit pas être propriétaire des tables ou de la fonction, ni superutilisateur.

Configurer les secrets de l'application :

- `DATABASE_URL` : connexion applicative habituelle ;
- `DEVICE_ENROLLMENT_DATABASE_URL` : connexion du compte `device_enrollment_login`.

Au démarrage, le backend vérifie l'identité réelle de la seconde connexion : `session_user`, absence de superuser, absence d'appartenance à `sync_app`, appartenance effective à `device_enrollment_executor` et privilège `EXECUTE` sur la signature exacte de la fonction. Une configuration invalide arrête le démarrage (fail closed).

## Migration sans CREATEROLE

Si le compte de migration n'a pas `CREATEROLE`, un DBA doit pré-provisionner `device_enrollment_executor` avec exactement les attributs ci-dessus avant d'exécuter la migration 036. La migration valide les attributs et échoue explicitement si le rôle existant est plus permissif.

## Frontière de confiance

- Le service NestJS valide la preuve initiale ES256 avant tout appel SQL.
- Le pool dédié ne peut appeler que les opérations explicitement accordées à son rôle, notamment la fonction atomique d'enrôlement.
- La fonction SECURITY DEFINER conserve l'atomicité de consommation du code, création du terminal pending, credential, événement d'audit, nonce et reçu d'idempotence.
- L'approbation reste une décision serveur distincte ; ce privilège ne permet pas d'approuver un terminal.
- Le pool général continue de porter les routes métier et la synchronisation ; aucun changement n'est apporté à l'Outbox Electron.

Le succès des tests de privilèges prouve la séparation dans la base de test. Il ne dispense pas de vérifier les rôles, secrets et memberships du cluster de production après déploiement.
