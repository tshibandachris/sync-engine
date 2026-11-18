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

## 2. Capture préalable obligatoire — avant d'appliquer 045

L'audit statique ne permet pas de connaître les changements manuels d'une base réelle. Pour rendre un rollback complet possible, conserver un dossier de preuve horodaté, protégé et associé à l'identifiant de l'environnement.

### 2.1 État de migration et de la table

- [ ] Sauvegarde PostgreSQL complète effectuée et restauration de cette sauvegarde testée.
- [ ] Résultat du ledger avant migration archivé.
- [ ] Définition complète de `public.tenants` capturée (`pg_dump --schema-only` ou équivalent).
- [ ] Liste des colonnes, types, valeurs par défaut, nullabilité, contraintes, index et commentaires capturée.
- [ ] Nombre de lignes et export cohérent des lignes de `public.tenants` conservés.
- [ ] Valeurs de `id` et `first_seen_at` conservées pour rapprochement.
- [ ] État RLS et politiques de la table capturés, même si 045 ne les modifie pas.

### 2.2 Privilèges effectifs et ACL

Capturer les privilèges avant migration avec les deux approches suivantes :

```sql
SELECT
  has_table_privilege('sync_app', 'public.tenants', 'SELECT') AS can_select,
  has_table_privilege('sync_app', 'public.tenants', 'INSERT') AS can_insert,
  has_table_privilege('sync_app', 'public.tenants', 'UPDATE') AS can_update,
  has_table_privilege('sync_app', 'public.tenants', 'DELETE') AS can_delete;
```

Dans `psql`, conserver également la sortie de :

```text
\dp public.tenants
```

Capturer les droits explicites par rôle :

```sql
SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'tenants'
ORDER BY grantee, privilege_type;
```

La requête `information_schema` ne remplace pas `has_table_privilege` : cette dernière vérifie le droit effectif, qui peut inclure des héritages ou appartenances.

### 2.3 Rôles et dépendances

Pour chacun des rôles `tenant_provisioning_function_owner` et `tenant_provisioning_executor`, capturer :

- existence avant 045 ;
- attributs de rôle (`LOGIN`, `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `INHERIT`, `REPLICATION`, `BYPASSRLS`) ;
- appartenances de rôles dans les deux sens ;
- privilèges sur le schéma `public` et sur `public.tenants` ;
- objets possédés et dépendances éventuelles.

Exemple de capture des attributs :

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolinherit, rolreplication, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname IN (
  'tenant_provisioning_function_owner',
  'tenant_provisioning_executor'
)
ORDER BY rolname;
```

### 2.4 Commentaires et données de cycle de vie

- [ ] Commentaire historique de la table `public.tenants` capturé.
- [ ] Commentaires historiques des colonnes existantes capturés.
- [ ] Export des nouvelles valeurs de cycle de vie prévu avant toute suppression de colonne : `status`, `created_at`, `created_by`, `suspended_at`, `suspended_reason`.
- [ ] Les exports sont protégés comme des données métier et leur restauration a été testée.

**Sans ces captures, l'état antérieur des rôles préexistants, des ACL manuelles, des commentaires et des données ajoutées après 045 ne peut pas être reconstitué avec certitude.** Le rollback reste conditionnel.

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

Les trois notions suivantes ne doivent jamais être confondues :

- **État historique prouvé :** état explicitement défini par les migrations antérieures, notamment 016.
- **État effectif observé juste avant 045 :** état réel capturé avant application ; il peut différer de l'historique à cause d'interventions manuelles ou de migrations non suivies.
- **État antérieur non capturé :** état qui ne peut pas être reconstitué après coup avec les seules migrations du dépôt.

| Élément | Changement introduit par 045 | Cible du rollback | Source / condition |
|---|---|---|---|
| Colonnes `status`, `created_at`, `created_by`, `suspended_at`, `suspended_reason` | Ajout de cinq colonnes | Les retirer uniquement après export et validation de conservation des données | Schéma antérieur prouvé par 016 ; données post-045 à archiver |
| Contraintes `tenants_status_check`, `tenants_suspension_state_check` | Deux contraintes CHECK | Les retirer avant les colonnes correspondantes | Noms et définitions prouvés par 045 |
| Droits de `sync_app` sur `public.tenants` | 045 retire tous les droits à `PUBLIC` et `sync_app`, puis accorde SELECT à `sync_app` | Restaurer exactement SELECT et INSERT pour `sync_app`, sans UPDATE ni DELETE | Migration 016 : `REVOKE ALL ... FROM PUBLIC, sync_app`, puis `GRANT SELECT, INSERT` |
| Droits de `PUBLIC` sur `public.tenants` | 045 exécute `REVOKE ALL` | Aucun droit accordé à PUBLIC | Migration 016 révoque explicitement ALL à PUBLIC |
| Rôle `tenant_provisioning_function_owner` | Créé s'il est absent ; sinon réutilisé si attributs compatibles ; reçoit USAGE sur `public` et SELECT/INSERT/UPDATE sur tenants | S'il a été créé par 045 : retirer ses ACL et le supprimer uniquement sans dépendance. S'il préexistait : restaurer son état capturé, sinon décision en attente | Capture préalable obligatoire ; 016 ne prouve pas son état antérieur |
| Rôle `tenant_provisioning_executor` | Créé s'il est absent ; sinon réutilisé ; reçoit USAGE sur `public` | Même règle : supprimer uniquement s'il a été créé par 045 et sans dépendance ; sinon restaurer la capture | Capture préalable obligatoire |
| Privilèges de schéma des deux rôles | USAGE pour executor ; USAGE final pour function_owner (CREATE accordé puis révoqué) | Restaurer l'ACL capturée ; si rôle nouvellement créé, retirer les droits avant suppression | État antérieur non prouvé par 016 |
| Commentaire de `public.tenants` | Remplacé par le commentaire de registre métier de 045 | Restaurer le commentaire capturé ; si non capturé, décision en attente | Pas de cible historique fiable dans l'audit statique |
| Commentaires des cinq nouvelles colonnes | Ajoutés par 045 | Disparaissent avec les colonnes après archivage des données | Définitions prouvées par 045 |
| Fonctions et triggers | Aucun changement par 045 | Aucune action de rollback | Audit de 045 |
| Politiques RLS et activation RLS | Aucun changement par 045 ; RLS de tenants reste désactivée | Aucune action de rollback attribuable à 045 | Audit et tests de 045 |

### 4.1 Restauration précise de `sync_app`

La cible historique est strictement :

```sql
REVOKE ALL ON TABLE public.tenants FROM sync_app;
GRANT SELECT, INSERT ON TABLE public.tenants TO sync_app;
```

Ne pas remplacer cette séquence par `GRANT ALL`. Ne pas oublier INSERT. La migration 016 constitue la preuve de cet état historique.

Après exécution, la requête `has_table_privilege` doit retourner :

| Droit | Résultat attendu |
|---|---:|
| SELECT | true |
| INSERT | true |
| UPDATE | false |
| DELETE | false |

Vérifier également `PUBLIC` : aucun droit ne doit lui être réattribué, conformément à 016.

### 4.2 Rôles préexistants : règle de non-destruction

045 ne conserve pas la provenance des rôles : un rôle créé par 045 et un rôle déjà présent avec des attributs compatibles peuvent avoir le même état après migration.

- Si la capture prouve que le rôle n'existait pas avant 045, sa suppression n'est envisageable qu'après révocation des ACL ajoutées et vérification qu'il ne possède aucun objet, aucune dépendance et aucune appartenance.
- Si la capture prouve qu'il existait, restaurer ses ACL et attributs à partir de cette capture.
- Si l'existence antérieure ou les ACL ne sont pas connues, **ne pas supprimer le rôle et ne pas deviner ses privilèges**. Laisser le rôle en place, isoler les droits ajoutés par 045 lorsque cela est sûr, et consigner une décision en attente.

## 5. Interaction avec `withTenant()` et traitement des tenants

Le rollback SQL de 045 et le comportement applicatif de `withTenant()` sont deux opérations distinctes. Un rollback SQL ne rétablit pas automatiquement le code applicatif antérieur.

| Schéma SQL | Code applicatif | Conséquence |
|---|---|---|
| 045 active | Ancien `withTenant()` avec inscription implicite | L'INSERT historique peut échouer car `sync_app` n'a plus INSERT ; le comportement de rattrapage applicatif doit être vérifié |
| 045 rollbackée | Ancien `withTenant()` | Les droits historiques SELECT/INSERT sont restaurés ; l'ancien parcours peut retrouver son comportement, sous réserve des autres changements |
| 045 rollbackée | Nouveau `withTenant()` qui refuse un tenant absent | L'absence du tenant reste une erreur ; restaurer les droits SQL ne réintroduit pas l'inscription implicite |
| 045 active | Nouveau `withTenant()` | Contrat cible : le tenant doit être provisionné explicitement avant l'opération tenant-scoped |

**Toute réversion applicative est une décision séparée.** Elle nécessite une approbation explicite, un commit applicatif identifié et des tests propres. Ne pas retoucher `withTenant()` pendant un rollback SQL non autorisé.

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

1. Déclarer une fenêtre de maintenance et suspendre les écritures applicatives concernées selon le plan d'exploitation approuvé.
2. Confirmer l'environnement, l'identité de la base et la révision applicative.
3. Vérifier le ledger `public.schema_migrations` et l'état réel du schéma.
4. Effectuer une sauvegarde fraîche et vérifier qu'elle est restaurable.
5. Capturer les privilèges effectifs, ACL, rôles, commentaires, données et inventaire des tenants.
6. Vérifier que l'archive des cinq colonnes de cycle de vie est complète et lisible.
7. Exécuter le rollback testé sur une copie isolée avant toute base réelle.
8. Si l'état d'un rôle, d'un commentaire ou d'une donnée est inconnu, appliquer le mode conditionnel : préserver et arrêter la partie destructive correspondante.
9. Restaurer les droits historiques de `sync_app` exactement comme en section 4.1.
10. Retirer les contraintes puis les colonnes 045 uniquement si les données sont archivées et la décision métier validée.
11. Traiter les rôles de provisioning selon la preuve de leur existence antérieure et leurs dépendances ; aucune suppression aveugle.
12. Vérifier les privilèges, le schéma, les données conservées et les journaux.
13. Redémarrer les services seulement après validation des contrôles et de la compatibilité applicative.

### 6.1 Ledger et garde-fou de double exécution

Le runner consulte `public.schema_migrations`. Ne pas supprimer ou modifier sa ligne 045 comme opération improvisée : cela pourrait provoquer une réapplication automatique de 045 au prochain lancement du runner si le fichier de migration est toujours présent.

Le script de rollback doit avoir un précontrôle atomique, dans la même transaction que les changements :

- si le ledger indique que 045 est appliquée **et** que les objets attendus sont présents, le rollback peut commencer ;
- si le ledger n'indique pas 045 et que les objets 045 sont absents, arrêter comme « déjà rollbacké / rien à faire » ;
- si le ledger et le schéma se contredisent, échouer immédiatement et demander une investigation ;
- si les objets sont partiellement présents, ne pas tenter de réparation automatique.

La ligne du ledger doit rester cohérente avec la stratégie de migrations du dépôt. La façon de tracer un rollback sans déclencher une réapplication de 045 doit être décidée avec le propriétaire du runner avant de produire un script exécutable. **Ce point est bloquant pour une exécution réelle.**

Un script non idempotent est acceptable uniquement s'il échoue de façon explicite et contrôlée à la seconde exécution, avant tout DDL. Ne pas utiliser `DROP COLUMN IF EXISTS` comme substitut au garde-fou : cela masque les états partiels et les erreurs de séquencement.

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

Tous les tests sont exécutés sur une base jetable, avec la même version PostgreSQL et les mêmes migrations que l'environnement cible. Aucun test ne doit utiliser Supabase réel.

### 8.1 Test fonctionnel de base

1. Appliquer les migrations jusqu'à 044.
2. Capturer l'état historique de `tenants`, des privilèges et des rôles.
3. Appliquer 045.
4. Vérifier les cinq colonnes, les deux contraintes, les deux rôles, les commentaires et les ACL post-045.
5. Créer des fixtures représentant un tenant historique, un tenant post-045 `pending` et un tenant suspendu, avec leurs données de cycle de vie.
6. Exécuter le rollback candidat.
7. Vérifier la restauration des privilèges historiques et l'absence des objets 045 ciblés.
8. Vérifier que les UUID et données conservées sont identiques et que l'archive contient toutes les valeurs de cycle de vie.

### 8.2 Test explicite de double exécution

Le test doit conserver les preuves des deux passages :

1. Exécuter le script de rollback une première fois.
2. Vérifier intégralement l'état post-rollback : ledger, colonnes, contraintes, rôles, ACL, données et archive.
3. Enregistrer un instantané de cet état.
4. Exécuter le même script une seconde fois.
5. Vérifier que l'état est strictement identique à l'instantané.
6. Vérifier que le second passage s'est arrêté proprement avant tout DDL, ou a terminé comme no-op idempotent.
7. Vérifier qu'aucune erreur inattendue, aucun changement de privilège et aucune perte de donnée ne sont survenus.

Si le script est conçu comme non idempotent, le deuxième passage doit être bloqué par le garde-fou de la section 6.1. Le test doit prouver que le blocage intervient avant toute instruction destructive. Un échec silencieux ou un état partiellement modifié est un échec du test.

### 8.3 Tests de divergence et de reprise

- [ ] Ledger absent + objets 045 absents : arrêt « déjà rollbacké / rien à faire ».
- [ ] Ledger absent + objets 045 présents : arrêt et investigation.
- [ ] Ledger présent + objets 045 absents : arrêt et investigation.
- [ ] Ledger présent + schéma 045 complet : chemin de rollback normal.
- [ ] Schéma partiel : arrêt sans tentative de réparation.
- [ ] Rôle préexistant avec ACL capturées : restauration exacte.
- [ ] Rôle préexistant sans capture : pas de suppression, décision en attente.
- [ ] Tenant `pending` dont l'origine est prouvée : conservation et rapprochement.
- [ ] Tenant `pending` d'origine inconnue : conservation, aucune promotion, décision en attente.
- [ ] Échec injecté avant commit : transaction annulée, aucun état partiel.
- [ ] Rejouer les migrations ordinaires après rollback pour confirmer que le runner ne réapplique pas 045 de manière inattendue.

### 8.4 Interaction applicative

Tester séparément les combinaisons de la matrice de la section 5. Ne pas conclure qu'un rollback SQL restaure l'ancien comportement applicatif. La validation doit couvrir le code réellement déployé, pas uniquement le schéma.

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
