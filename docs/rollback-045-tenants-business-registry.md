# Procédure de rollback — migration 045

> **Statut :** procédure documentaire de préparation, non exécutée.
>
> **Migration concernée :** `045_tenants_business_registry.sql`
>
> **État au moment de la rédaction :** la migration 045 est présente sur la branche de travail de la PR #113, validée en PostgreSQL isolé, mais n'est pas mergée sur `main` et n'a pas été appliquée à Supabase ou à une base de production.
>
> **Règle absolue :** ce document n'autorise ni l'application de 045, ni son rollback, ni un déploiement. Toute intervention réelle exige une approbation distincte, un opérateur habilité, une sauvegarde vérifiée et une fenêtre de maintenance.

## 1. Objectif et règle de décision

Ce runbook décrit comment revenir sur les changements de schéma et de privilèges de 045 si, après son application, le parcours métier est bloqué.

**Le mode par défaut est un rollback conditionnel.** Il conserve les données et les objets dont l'état antérieur n'est pas démontrable, et s'arrête devant toute ambiguïté.

Un rollback complet n'est envisageable que si la checklist de capture de la section 2 a été exécutée avant 045 et si les tests de la section 8 sont passés sur une copie isolée représentative.

Ne jamais improviser un `GRANT ALL`, un `DROP ... IF EXISTS` généralisé, une suppression de tenant, une promotion automatique de `pending` vers `active`, ou une modification manuelle du ledger pour « faire passer » le runner.

## 2. Capture préalable obligatoire — avant 045

La capture doit être produite avant l'application de 045, horodatée, liée à l'environnement et conservée dans un emplacement protégé. Les commandes ci-dessous sont des exemples à exécuter par un opérateur habilité sur la base cible ; elles ne sont pas exécutées dans le cadre de cette PR.

### 2.1 Sauvegarde, ledger et définition du schéma

- [ ] Sauvegarde PostgreSQL complète effectuée et restauration testée sur une base isolée.
- [ ] Version PostgreSQL, identité de l'environnement et révision applicative consignées.
- [ ] Ledger archivé.
- [ ] Dump de schéma et de données historiques de tenants conservés.
- [ ] Nombre de lignes, UUID et first_seen_at conservés.

~~~sql
SELECT current_database(), current_user,
       current_setting('server_version'), clock_timestamp();

SELECT filename, applied_at
FROM public.schema_migrations
ORDER BY filename;

SELECT count(*) AS tenant_count FROM public.tenants;
SELECT id, first_seen_at FROM public.tenants ORDER BY id;
~~~

Depuis un terminal disposant de pg_dump :

~~~sh
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" \
  --table=public.tenants > tenants-before-045.schema.sql
pg_dump --data-only --column-inserts "$DATABASE_URL" \
  --table=public.tenants > tenants-before-045.data.sql
~~~

Ces exports ne remplacent pas la sauvegarde complète et son test de restauration.

### 2.2 Colonnes, contraintes, index, RLS et commentaires

~~~sql
SELECT column_name, ordinal_position, data_type, udt_name,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tenants'
ORDER BY ordinal_position;

SELECT c.conname, pg_catalog.pg_get_constraintdef(c.oid, true) AS definition
FROM pg_catalog.pg_constraint c
WHERE c.conrelid = 'public.tenants'::regclass
ORDER BY c.conname;

SELECT indexname, indexdef
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public' AND tablename = 'tenants'
ORDER BY indexname;

SELECT c.relrowsecurity, c.relforcerowsecurity,
       pg_catalog.obj_description(c.oid, 'pg_class') AS table_comment
FROM pg_catalog.pg_class c
WHERE c.oid = 'public.tenants'::regclass;

SELECT a.attname, pg_catalog.col_description(a.attrelid, a.attnum) AS column_comment
FROM pg_catalog.pg_attribute a
WHERE a.attrelid = 'public.tenants'::regclass
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;

SELECT schemaname, tablename, policyname, permissive, roles,
       cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename = 'tenants'
ORDER BY policyname;
~~~

### 2.3 Privilèges effectifs et ACL

~~~sql
SELECT
  has_table_privilege('sync_app', 'public.tenants', 'SELECT') AS can_select,
  has_table_privilege('sync_app', 'public.tenants', 'INSERT') AS can_insert,
  has_table_privilege('sync_app', 'public.tenants', 'UPDATE') AS can_update,
  has_table_privilege('sync_app', 'public.tenants', 'DELETE') AS can_delete;

SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'tenants'
ORDER BY grantee, privilege_type;

SELECT n.nspname, x.grantee, x.privilege_type, x.is_grantable
FROM pg_catalog.pg_namespace n
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
) x
WHERE n.nspname = 'public'
ORDER BY x.grantee, x.privilege_type;
~~~

Dans psql, archiver aussi les sorties de :

~~~text
\dp public.tenants
\dn+ public
~~~

La requête has_table_privilege mesure les droits effectifs ; les vues ACL montrent les attributions explicites. Conserver les deux.

### 2.4 Rôles, appartenances, propriétaires et dépendances

~~~sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolinherit, rolreplication, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname IN (
  'tenant_provisioning_function_owner',
  'tenant_provisioning_executor'
)
ORDER BY rolname;

SELECT granted.rolname AS granted_role,
       member.rolname AS member_role, m.admin_option
FROM pg_catalog.pg_auth_members m
JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
JOIN pg_catalog.pg_roles member ON member.oid = m.member
WHERE granted.rolname IN (
  'tenant_provisioning_function_owner', 'tenant_provisioning_executor'
) OR member.rolname IN (
  'tenant_provisioning_function_owner', 'tenant_provisioning_executor'
)
ORDER BY granted_role, member_role;

SELECT c.relkind, n.nspname, c.relname,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relowner IN (
  SELECT oid FROM pg_catalog.pg_roles
  WHERE rolname IN ('tenant_provisioning_function_owner',
                    'tenant_provisioning_executor')
)
ORDER BY n.nspname, c.relname;

SELECT p.oid::regprocedure AS routine,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner
FROM pg_catalog.pg_proc p
WHERE p.proowner IN (
  SELECT oid FROM pg_catalog.pg_roles
  WHERE rolname IN ('tenant_provisioning_function_owner',
                    'tenant_provisioning_executor')
)
ORDER BY routine;
~~~

Auditer également les objets hors schéma public, les propriétaires de bases/schémas et les privilèges par défaut. Les requêtes ci-dessus sont ciblées et ne prouvent pas seules l'absence de toute dépendance.

### 2.5 Commentaires et preuve de capture

- [ ] Commentaire de table et commentaires de toutes les colonnes historiques sauvegardés.
- [ ] Attributs, ACL, existence/absence et appartenances des deux rôles sauvegardés.
- [ ] Propriétaires et dépendances audités.
- [ ] Artefacts horodatés, protégés, vérifiables et associés à un capture_id unique.

Si la capture n'a pas été faite avant 045, les états antérieurs des rôles, ACL manuelles, propriétaires et commentaires ne peuvent pas être reconstitués avec certitude à partir du dépôt.

### 2.6 Données à archiver après 045, avant le rollback

Les valeurs de cycle de vie n'existent pas avant 045. Elles doivent donc être exportées après application de 045 et avant toute suppression de colonne :

~~~sql
SELECT id, status, created_at, created_by, suspended_at, suspended_reason
FROM public.tenants
ORDER BY id;
~~~

L'export couvre tous les tenants et tous les statuts, est rapproché par UUID, stocké hors de la base à modifier et testé en lecture/restauration. Sans export complet validé, aucun DROP COLUMN n'est autorisé.

## 3. Précontrôles avant toute intervention

Aucune commande de rollback ne doit être lancée avant les vérifications suivantes.

### 3.1 Confirmer que 045 est enregistrée

Le runner utilise `public.schema_migrations`. Vérifier l'enregistrement exact :

```sql
SELECT filename, applied_at
FROM public.schema_migrations
WHERE filename = '045_tenants_business_registry.sql';
```

- Une ligne doit être présente pour considérer 045 comme enregistrée.
- Aucune ligne : ne pas exécuter le rollback 045. Examiner l'état du schéma et le journal d'application.
- Plusieurs lignes ne devraient pas être possibles avec le ledger attendu : arrêter et investiguer.
- Vérifier aussi la version du code déployé et la révision exacte du runner.

Le ledger n'est pas une preuve suffisante à lui seul : confronter son résultat à la présence des cinq colonnes, des deux contraintes et des deux rôles.

### 3.2 Vérifier l'état effectif des droits avant rollback

Exécuter et archiver la requête suivante avant toute modification :

```sql
SELECT
  has_table_privilege('sync_app', 'public.tenants', 'SELECT') AS can_select,
  has_table_privilege('sync_app', 'public.tenants', 'INSERT') AS can_insert,
  has_table_privilege('sync_app', 'public.tenants', 'UPDATE') AS can_update,
  has_table_privilege('sync_app', 'public.tenants', 'DELETE') AS can_delete;
```

Capturer aussi `\dp public.tenants` et la requête `information_schema.role_table_grants` de la section 2.2. Si l'état effectif diffère de l'état attendu après 045, arrêter : il peut exister des droits indirects ou des changements hors migration.

### 3.3 Vérifier les tenants et les données

Produire un inventaire des statuts et des lignes récentes. Ne pas modifier les statuts pendant cette phase.

```sql
SELECT status, count(*)
FROM public.tenants
GROUP BY status
ORDER BY status;
```

Pour le rollback, classer les lignes en trois ensembles à partir des preuves disponibles :

1. lignes présentes avant 045, backfillées en `active` par 045 ;
2. lignes créées après 045 et explicitement provisionnées ;
3. lignes créées après 045 dont l'origine ou l'autorisation n'est pas établie.

Une ligne `pending` ne doit pas être supprimée ou activée automatiquement. Son origine doit être déterminée par les journaux et les preuves de provisioning.

## 4. Ce que le rollback restaure exactement

Trois notions ne doivent jamais être confondues :

- **État historique prouvé :** état explicitement défini par les migrations antérieures, notamment 016.
- **État effectif capturé juste avant 045 :** état réel de l'environnement, y compris les interventions manuelles et migrations hors dépôt ; il prévaut pour restaurer fidèlement cet environnement.
- **État antérieur non capturé :** inconnu. Il ne faut ni le deviner ni prétendre le restaurer.

| Élément | Cible après rollback | Source de l'état restauré | Condition / limite |
|---|---|---|---|
| Structure de public.tenants | Colonnes historiques id, first_seen_at | Migration 016 + dump pré-045 | Ne retirer les colonnes 045 qu'après capture pré-045 et archive post-045 validée |
| Contraintes tenants_status_check et tenants_suspension_state_check | Absentes | Définitions créées par 045 | Retirer avant les colonnes, après contrôle exact |
| Droits sync_app | SELECT et INSERT, sans UPDATE ni DELETE | Migration 016 ; confirmer avec ACL pré-045 | Jamais GRANT ALL |
| Droits PUBLIC | Aucun droit sur public.tenants | Migration 016 + capture effective | Ne pas réattribuer de privilège |
| Rôle tenant_provisioning_function_owner | État capturé ; absent uniquement si la capture prouve son absence | Capture pré-045 | Si état non capturé ou dépendances inconnues : conserver, ne pas supprimer |
| Rôle tenant_provisioning_executor | État capturé ; absent uniquement si la capture prouve son absence | Capture pré-045 | Même garde-fou |
| ACL du schéma public | État capturé avant 045 | Capture pré-045 | Ne pas déduire l'état antérieur de 016 |
| Commentaire de table et colonnes historiques | Texte exact capturé avant 045 | Capture pré-045 | Sans capture, ne pas inventer de commentaire |
| Commentaires des cinq nouvelles colonnes | Disparaissent avec les colonnes | 045 | Exporter les valeurs avant suppression |
| Fonctions, triggers et RLS | Inchangés | Audit de 045 | 045 n'en crée/modifie aucun et ne change pas RLS |
| Données de cycle de vie | Conservées dans une archive vérifiée | Export post-045, rapprochement par UUID | Archive absente/incomplète : arrêt, pas de DROP |

### 4.1 Droits exacts de sync_app

L'état historique prouvé par 016 est :

~~~sql
REVOKE ALL ON TABLE public.tenants FROM sync_app;
GRANT SELECT, INSERT ON TABLE public.tenants TO sync_app;
~~~

Aucun UPDATE, DELETE ou GRANT ALL. La cible effective est true, true, false, false pour SELECT, INSERT, UPDATE, DELETE. Les droits PUBLIC restent révoqués conformément à 016. Le dump ACL pré-045 prévaut si l'environnement avait des changements manuels.

### 4.2 Rôles : aucune suppression par défaut

045 crée chaque rôle seulement s'il est absent ; sinon il le réutilise si ses attributs sont compatibles. L'état post-migration ne révèle donc pas si le rôle existait avant.

- Capture prouvant l'absence + audit prouvant aucune dépendance, propriété ou appartenance : suppression éventuellement possible après révocation des ACL ajoutées par 045.
- Capture prouvant l'existence : restaurer attributs, ACL et appartenances depuis la capture.
- Capture absente/incomplète : ne pas supprimer le rôle et ne pas deviner les ACL. Préserver le rôle et soumettre sa remise en état à une décision distincte.

Le squelette SQL ne supprime automatiquement aucun rôle.

## 5. Tableau à trois états — withTenant()

Le rollback SQL et le code applicatif sont indépendants. La matrice décrit les trois états applicatifs utiles :

| État | Schéma SQL | Code withTenant() | Comportement attendu |
|---|---|---|---|
| A — situation antérieure | 045 rollbackée, privilèges historiques restaurés | Ancienne version avec inscription implicite | Le chemin historique peut insérer le tenant grâce à SELECT, INSERT, sous réserve des autres changements applicatifs |
| B — transition mixte | 045 active, sync_app limité à SELECT | Ancienne version avec inscription implicite | L'INSERT implicite peut échouer ; le fallback doit être vérifié, ne pas supposer qu'il fonctionne |
| C — contrat cible | 045 active, provisioning explicite | Nouvelle version stricte qui refuse un tenant absent | Le tenant doit être provisionné avant l'opération tenant-scoped ; aucun INSERT implicite par withTenant() |

Si le schéma est rollbacké mais que la nouvelle version stricte reste déployée, l'absence du tenant demeure une erreur : restaurer INSERT en SQL ne réintroduit pas l'inscription implicite. Toute réversion de withTenant() exige une approbation séparée et des tests applicatifs identifiés. Ne pas modifier ce code dans le cadre du rollback SQL.



### 5.1 Règle de conservation des tenants `pending`

045 ajoute `status` avec le défaut `pending`, puis backfill les lignes préexistantes en `active`. Le backfill ne crée aucune ligne.

Par conséquent, une ligne `pending` observée après 045 correspond à une insertion postérieure à la migration. Son origine peut être un provisioning autorisé ou un autre flux ; l'origine doit être prouvée par les journaux et les traces disponibles.

Pour chaque tenant post-045 :

- conserver son UUID et ses données ;
- déterminer l'acteur, l'heure et le chemin de création ;
- conserver les valeurs de cycle de vie dans l'archive de rollback ;
- ne pas supprimer une ligne `pending` ;
- ne pas la promouvoir automatiquement en `active` ;
- si son statut ou son origine ne peut pas être préservé dans le schéma historique, maintenir l'archive et ouvrir une décision de réconciliation métier avant la suppression des colonnes.

Le rollback du schéma ne doit pas effacer la piste d'audit du cycle de vie.

## 6. Procédure opérationnelle — uniquement après approbation distincte

1. Déclarer une fenêtre de maintenance et suspendre les écritures concernées.
2. Confirmer l'environnement, la révision applicative et le SHA déployé.
3. Vérifier ledger, schéma, rôles, ACL et privilèges effectifs.
4. Effectuer une sauvegarde fraîche et vérifier sa restauration.
5. Vérifier la capture pré-045 et l'archive post-045 des cinq colonnes.
6. Tester le script candidat sur une copie isolée représentative.
7. Si une preuve manque ou si un état diverge, arrêter sans DDL destructif.
8. Exécuter le rollback uniquement après autorisation distincte.
9. Vérifier ledger, registre de rollback, schéma, privilèges, archive et compatibilité applicative.

### 6.1 Stratégie du ledger et du registre schema_rollbacks

**Conserver la ligne 045 dans public.schema_migrations.** Le runner consulte ce ledger et ignore une migration déjà enregistrée. Supprimer la ligne 045 pourrait provoquer la réapplication du fichier au prochain lancement du runner. Le rollback ne modifie ni ne supprime aucune ligne de schema_migrations.

La trace est conservée séparément dans public.schema_rollbacks. Cette table n'est pas le ledger des migrations. Elle est créée et alimentée dans la même transaction que le rollback : un échec annule aussi la création du registre et l'insertion.

~~~sql
CREATE TABLE public.schema_rollbacks (
  migration_filename text PRIMARY KEY,
  rolled_back_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rollback_version text NOT NULL,
  reason text NOT NULL,
  evidence_reference text NOT NULL,
  capture_id text NOT NULL,
  executed_by name NOT NULL DEFAULT current_user
);
~~~

Insertion, dans la transaction du rollback :

~~~sql
INSERT INTO public.schema_rollbacks (
  migration_filename, rollback_version, reason,
  evidence_reference, capture_id
) VALUES (
  '045_tenants_business_registry.sql',
  'rollback-045-v1',
  :'rollback_reason',
  :'evidence_reference',
  :'capture_id'
);
~~~

Les trois paramètres psql doivent être fournis par l'opérateur à partir des preuves réelles. Les droits d'écriture au registre doivent être limités au rôle d'exploitation approuvé ; la protection contre UPDATE/DELETE et la rétention d'audit doivent être définies avant exécution réelle.

### 6.2 Garde-fou d'idempotence

Le script prend un verrou consultatif transactionnel, puis vérifie l'existence d'une ligne pour 045 :

~~~sql
SELECT migration_filename, rolled_back_at, rollback_version,
       capture_id, evidence_reference
FROM public.schema_rollbacks
WHERE migration_filename = '045_tenants_business_registry.sql';
~~~

- Si une ligne existe, **refuser proprement la seconde exécution** avec le message ROLLBACK_ALREADY_RECORDED: 045_tenants_business_registry.sql. Aucun DDL n'est exécuté.
- Si aucune ligne n'existe, continuer seulement si tous les précontrôles sont satisfaits.
- Si le registre existe avec une structure inattendue ou si les preuves divergent, refuser et demander une investigation.

La seconde exécution n'est pas un no-op silencieux : elle retourne une erreur explicite avant toute opération destructive.

### 6.3 Structure du script SQL inverse — squelette non exécutable tel quel

L'ensemble doit être exécuté dans une seule transaction PostgreSQL. Les précontrôles doivent vérifier les définitions exactes, pas seulement les noms.

~~~sql
BEGIN;

-- Sérialiser les tentatives concurrentes.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('rollback:045_tenants_business_registry.sql', 0)
);

-- Créer le registre dans la transaction si absent.
CREATE TABLE IF NOT EXISTS public.schema_rollbacks (
  migration_filename text PRIMARY KEY,
  rolled_back_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rollback_version text NOT NULL,
  reason text NOT NULL,
  evidence_reference text NOT NULL,
  capture_id text NOT NULL,
  executed_by name NOT NULL DEFAULT current_user
);

-- Refuser une seconde exécution avant tout DDL de rollback.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.schema_rollbacks
    WHERE migration_filename = '045_tenants_business_registry.sql'
  ) THEN
    RAISE EXCEPTION
      'ROLLBACK_ALREADY_RECORDED: 045_tenants_business_registry.sql';
  END IF;
END
$guard$;

-- Précontrôles fail-closed : chacun lève RAISE EXCEPTION en cas d'échec.
-- 1) exactement une ligne 045 dans schema_migrations ;
-- 2) cinq colonnes et deux contraintes 045 présentes avec définitions attendues ;
-- 3) deux rôles présents avec attributs post-045 attendus ;
-- 4) ACL post-045 conformes à 045 ;
-- 5) capture pré-045 complète, capture_id et evidence_reference vérifiables ;
-- 6) export post-045 des cinq colonnes complet, testé et rapproché ;
-- 7) aucune divergence de schéma, dépendance ou écriture concurrente.
-- Tout échec => REFUS D'EXÉCUTION, avant toute instruction destructive.

-- Ne jamais modifier ni supprimer la ligne de schema_migrations.
-- Restaurer uniquement les privilèges historiques prouvés.
REVOKE ALL ON TABLE public.tenants FROM PUBLIC, sync_app;
GRANT SELECT, INSERT ON TABLE public.tenants TO sync_app;

-- Restaurer commentaires et ACL de schéma depuis la capture validée.
-- Sans valeur exacte capturée : RAISE EXCEPTION.

-- Retirer les contraintes exactes après contrôle.
ALTER TABLE public.tenants
  DROP CONSTRAINT tenants_status_check,
  DROP CONSTRAINT tenants_suspension_state_check;

-- Vérifier à nouveau l'archive juste avant toute suppression.
-- Archive absente/incomplète : RAISE EXCEPTION ; aucun DROP COLUMN.
ALTER TABLE public.tenants
  DROP COLUMN status,
  DROP COLUMN created_at,
  DROP COLUMN created_by,
  DROP COLUMN suspended_at,
  DROP COLUMN suspended_reason;

-- Restaurer les rôles préexistants depuis la capture.
-- Ne supprimer aucun rôle automatiquement dans ce squelette.

-- Vérifier état final : colonnes/contraintes absentes, ACL exactes,
-- commentaires et rôles conformes à la capture, données rapprochées.
-- Toute divergence lève une exception et annule la transaction.

INSERT INTO public.schema_rollbacks (
  migration_filename, rollback_version, reason,
  evidence_reference, capture_id
) VALUES (
  '045_tenants_business_registry.sql',
  'rollback-045-v1',
  :'rollback_reason',
  :'evidence_reference',
  :'capture_id'
);

-- Contrôler le registre et l'état final avant validation.
COMMIT;
~~~

Ce squelette décrit l'ordre et les garde-fous ; il n'est pas un script prêt à exécuter. Les contrôles de capture et d'archive doivent être raccordés à un format de preuve vérifiable. Si un précontrôle échoue, le script lève une exception, la transaction est annulée et **il refuse de s'exécuter**. Aucun DROP COLUMN n'est permis avant validation de l'archive.

Le registre créé et alimenté dans la même transaction ne conserve aucune trace de succès si la transaction échoue. Après un commit réussi, sa ligne bloque une seconde exécution. schema_migrations reste inchangé, ce qui évite le rejeu de 045 par le runner.



## 7. Vérifications après rollback

### 7.1 Privilèges effectifs

Exécuter à nouveau :

```sql
SELECT
  has_table_privilege('sync_app', 'public.tenants', 'SELECT') AS can_select,
  has_table_privilege('sync_app', 'public.tenants', 'INSERT') AS can_insert,
  has_table_privilege('sync_app', 'public.tenants', 'UPDATE') AS can_update,
  has_table_privilege('sync_app', 'public.tenants', 'DELETE') AS can_delete;
```

Résultat exigé : `true, true, false, false`, dans cet ordre. Archiver aussi `\dp public.tenants` et la requête `information_schema.role_table_grants`.

### 7.2 Schéma et données

- [ ] Les cinq colonnes ajoutées par 045 ne sont présentes que si le rollback est volontairement conditionnel et qu'une décision documentée impose de les conserver ; sinon elles sont retirées après archivage.
- [ ] Les deux contraintes ajoutées par 045 sont absentes après rollback complet.
- [ ] Les lignes et UUID des tenants historiques sont conservés.
- [ ] Les tenants créés après 045 sont rapprochés de l'archive ; aucune ligne n'a été supprimée ou promue implicitement.
- [ ] Les données de cycle de vie sont conservées dans l'archive validée.
- [ ] Les commentaires restaurés correspondent à la capture préalable ; sans capture, le point reste explicitement en attente.
- [ ] Les rôles et ACL correspondent à la capture ou sont laissés en place avec décision en attente.
- [ ] Aucune fonction, aucun trigger et aucune politique RLS n'a été modifié par le rollback.

## 8. Tests de rollback obligatoires en PostgreSQL isolé

Tous les tests sont exécutés sur une base jetable avec la même version PostgreSQL et la même séquence de migrations que l'environnement cible. Aucun test ne doit utiliser Supabase réel.

1. Appliquer les migrations jusqu'à 044.
2. Exécuter les captures pré-045 et vérifier qu'elles sont exploitables.
3. Appliquer 045.
4. Créer des fixtures : tenant historique, tenant post-045 pending, active et suspended.
5. Exporter et vérifier les cinq colonnes de cycle de vie.
6. Exécuter le script candidat ; vérifier schéma, ACL, registre, ledger et archive.
7. Relancer le script : il doit retourner ROLLBACK_ALREADY_RECORDED avant tout DDL ; comparer l'état à l'instantané après le premier rollback.
8. Injecter un échec avant COMMIT : la transaction doit annuler toutes les modifications et ne laisser aucune trace de succès.
9. Vérifier les cas divergents ci-dessous.
10. Relancer le runner : il ne doit pas réappliquer 045 puisque sa ligne reste dans schema_migrations.

Cas négatifs obligatoires :
- ledger absent + objets 045 absents : refus / rien à rollback ;
- ledger absent + objets 045 présents : refus et investigation ;
- ledger présent + objets 045 absents sans trace de rollback : refus et investigation ;
- ledger présent + schéma 045 complet : seul état admissible pour le chemin normal ;
- schéma partiel ou définition différente : refus avant DDL ;
- capture pré-045 manquante : refus du rollback destructif ;
- archive post-045 manquante/incomplète : refus avant tout DROP COLUMN ;
- rôle préexistant ou d'existence antérieure inconnue : aucune suppression ;
- seconde exécution : erreur explicite, pas de double exécution silencieuse ;
- tentatives concurrentes : verrou et contrôle du registre empêchent deux rollbacks simultanés.



## 9. Critères d'arrêt immédiat

Arrêter sans poursuivre si :

- l'environnement ou le SHA déployé n'est pas identifié ;
- le ledger et le schéma ne concordent pas ;
- la sauvegarde n'a pas été restaurée en test ;
- les privilèges effectifs ne correspondent pas à l'état attendu ;
- un rôle préexistant n'a pas d'état de référence exploitable ;
- des données de cycle de vie ne sont pas archivées ;
- un tenant `pending` ou suspendu risque d'être supprimé, activé ou perdu ;
- le comportement applicatif après rollback n'est pas défini ;
- le runner pourrait réappliquer 045 après redémarrage ;
- le test de double exécution ou les tests de divergence échouent.

## 10. Limites et décisions en attente

Les points suivants restent explicitement bloquants avant toute exécution réelle :

1. **Provenance des rôles :** l'état des rôles de provisioning avant 045 doit être capturé. Sans capture, pas de suppression ni de restauration supposée.
2. **ACL et commentaires préexistants :** restaurer depuis les captures ; sinon conserver et demander une décision.
3. **Données de cycle de vie :** valider le format d'archive, la rétention, l'accès et la procédure de rapprochement avant toute suppression de colonnes.
4. **Ledger :** décider et tester comment le runner représente un rollback sans réappliquer 045. Ne pas effacer arbitrairement la ligne du ledger.
5. **Application :** décider séparément si le code `withTenant()` doit être rollbacké ou conservé.
6. **Droits de `sync_app` :** cible historique prouvée : SELECT et INSERT uniquement sur `public.tenants`.

## 11. Références auditées

- `migrations/016_tenants_registry.sql` : création de la table et privilèges historiques `sync_app` / `PUBLIC`.
- `migrations/045_tenants_business_registry.sql` : colonnes, contraintes, rôles, commentaires et ACL introduits.
- `src/with-tenant.ts` et `src/tenant-registry.ts` : parcours applicatif d'accès et d'inscription des tenants.
- `scripts/migrate.sh` : ledger `public.schema_migrations` et comportement du runner.
- Tests PostgreSQL de la migration 045 : vérifications des rôles, privilèges et contrat du registre.

**Ce runbook est une spécification de rollback à relire et tester. Il ne constitue pas un script exécutable ni une autorisation d'intervention en production.**
