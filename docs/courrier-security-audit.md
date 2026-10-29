# Audit de sécurité — module Courrier

**Date :** 2026-10-29  
**Dépôt audité :** `tshibandachris/sync-engine`  
**Branche de référence :** `main`  
**Commit de référence :** `082fb3e8a7cec507aedf524f8a95dc075d991556`  
**Branche de travail :** `feat/courrier-security-foundation`

## Résultat de l’audit

Le module Courrier n’existe pas dans `main`. L’arbre Git ne contient aucun fichier correspondant à `courrier`, `courier`, `PolicyService`, `PermissionsGuard` ou `default-role`. Le dépôt contient actuellement le backend NestJS de Sync Engine / Eden Gestion : synchronisation, authentification JWT, pièces jointes, caisse et données POS.

Les fichiers d’architecture lus comprennent `README.md`, `CONTRIBUTING.md`, `src/app.module.ts`, `src/schema.ts`, `src/jwt.guard.ts`, `src/with-tenant.ts`, `src/tenant-id.ts`, `src/sync-attachment.controller.ts` et `src/sync-attachment.service.ts`. Aucun `AGENTS.md` n’est présent à la racine ni dans l’arbre parcouru.

## Contraintes d’intégration à respecter

- L’identité HTTP actuellement validée est `request.agentId` + `request.tenantId`; les services existants utilisent `withTenant(db, tenantId, ...)`.
- Les données tenant-scoped doivent être interrogées dans `withTenant`; la migration 010 active et force la RLS sur les tables existantes.
- Le dépôt exige une migration SQL nouvelle pour tout changement de schéma et des tests associés. Les migrations existantes ne doivent pas être modifiées.
- Les exemples Courrier fournis auparavant utilisent `organisationId`, `users`, `roles` et `userRoles`, qui ne correspondent pas au modèle actuellement visible dans ce dépôt. Les copier tels quels introduirait des références inexistantes et ne serait pas une correction sûre.

## Risques de sécurité à couvrir lors de la création

1. **Isolation tenant** : toutes les tables Courrier doivent porter un `tenant_id`, utiliser RLS avec refus par défaut et être lues/écrites dans `withTenant`.
2. **Rôles** : toute jointure entre membres, rôles et permissions doit être limitée au même tenant. Un rôle provenant d’un autre tenant ne doit jamais conférer de permission.
3. **Confidentialité** : valider les niveaux reçus au runtime avec une liste autorisée explicite. Une valeur inconnue doit être rejetée, jamais traitée comme un niveau public ou un accès par défaut.
4. **Affectations** : toute lecture d’affectation doit être bornée à la fois par `tenant_id` et par le courrier visé. Les identifiants seuls ne constituent pas une autorisation.
5. **Listes et détails** : les règles de visibilité d’une liste doivent être équivalentes aux règles d’accès au détail; les filtres d’accès doivent être appliqués dans la requête, pas après avoir chargé tous les enregistrements.
6. **Pièces jointes et exports** : tout endpoint de téléchargement, prévisualisation, recherche ou export doit réévaluer l’autorisation sur le courrier parent.
7. **Journal d’audit** : journaliser les refus sans enregistrer le corps du courrier ni d’autres données sensibles. Définir explicitement si une panne du journal doit bloquer l’opération.
8. **Privilèges** : ne pas réutiliser les permissions de caisse/synchronisation comme autorisations Courrier. Garder les permissions et les contrôles métier dédiés.

## Plan de mise en œuvre

- Définir les tables et contraintes Courrier dans une nouvelle migration, avec RLS et tests d’isolation tenant.
- Ajouter les types Drizzle correspondants dans `src/schema.ts`.
- Implémenter un service de politique fail-closed et un contrôleur protégé par `JwtAuthGuard`.
- Ajouter des tests pour les rôles inter-tenant, les niveaux de confidentialité invalides, les affectations croisées, les refus d’accès, la visibilité des listes et les écritures concurrentes pertinentes.
- Enregistrer les providers dans `src/app.module.ts` sans changer les routes existantes.
- Exécuter `npm run typecheck` et `npm test`/CI avant de considérer la branche prête.

## État de cette branche

Cette première modification consigne le résultat de l’audit et les invariants de sécurité. Elle ne change ni le comportement de production ni `main`. Le module fonctionnel doit être construit sur ces bases; aucun test n’est déclaré réussi par cet audit seul.
