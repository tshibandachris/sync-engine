# Supabase Auth — configuration de production

Supabase Auth est le fournisseur OIDC/JWKS retenu pour Eden Sync Engine. La configuration reste un prérequis avant toute exposition publique.

## 1. Clés de signature asymétriques obligatoires

Dans le tableau de bord Supabase, ouvrir **Project Settings → JWT Keys** (le libellé peut varier selon la version du tableau de bord) et vérifier la clé active.

- Utiliser une clé asymétrique **ES256** ou **RS256**.
- Ne pas conserver le secret partagé historique HS256 comme clé de signature active.
- Vérifier que le JWKS public expose la clé publique correspondante et que son champ `alg` est ES256 ou RS256.
- L'API refuse explicitement tous les algorithmes autres que ES256 et RS256.

JWKS URL : `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`

Issuer : `https://<project-ref>.supabase.co/auth/v1`

Audience habituelle des access tokens Supabase : `authenticated`. Confirmer la valeur réelle d'un access token émis par le projet avant de renseigner `JWT_AUDIENCE`.

## 2. Claims issus uniquement de app_metadata

Les claims requis sont `agent_id` (UUID métier) et `tenantId` (UUID du tenant).

Ces deux valeurs doivent être maintenues exclusivement côté serveur dans `auth.users.raw_app_meta_data` (exposées comme `app_metadata`). Ne jamais les lire depuis `user_metadata`, les paramètres d'inscription ou un champ modifiable par l'utilisateur.

Le Custom Access Token Hook doit copier les deux valeurs depuis les métadonnées administratives vers les claims JWT. Exemple à adapter et tester dans le projet :

```sql
create or replace function public.eden_custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  metadata jsonb;
  agent_id_value uuid;
  tenant_id_value uuid;
begin
  select u.raw_app_meta_data
    into metadata
    from auth.users as u
   where u.id = (event ->> 'user_id')::uuid;

  if metadata is null then
    raise exception 'Missing server-managed app_metadata';
  end if;

  agent_id_value := (metadata ->> 'agent_id')::uuid;
  tenant_id_value := (metadata ->> 'tenantId')::uuid;

  if agent_id_value is null or tenant_id_value is null then
    raise exception 'Missing agent_id or tenantId in app_metadata';
  end if;

  claims := jsonb_set(claims, '{agent_id}', to_jsonb(agent_id_value::text), true);
  claims := jsonb_set(claims, '{tenantId}', to_jsonb(tenant_id_value::text), true);
  return jsonb_set(event, '{claims}', claims, true);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.eden_custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.eden_custom_access_token_hook(jsonb) from authenticated, anon, public;
```

Activer ce hook dans **Authentication → Hooks → Custom Access Token**. Les valeurs `app_metadata` doivent être écrites par un processus d'administration fiable utilisant le service role ou une opération backend autorisée. Ne jamais exposer la clé service role dans le client. L'API exige `sub`, `agent_id` et `tenantId` au format UUID ; les valeurs imbriquées dans `user_metadata` ne sont jamais acceptées.

## 3. Procédure de test avec un compte Supabase dédié

Effectuer ces vérifications dans un projet Supabase de test isolé, avec un utilisateur jetable et des UUID de test. Ne jamais réutiliser un compte ou des données de production.

1. Créer un utilisateur de test dans **Authentication → Users**.
2. Par un mécanisme d'administration de confiance (dashboard ou backend protégé), attribuer à cet utilisateur des valeurs UUID de test dans `app_metadata.agent_id` et `app_metadata.tenantId`. Ne jamais placer ces valeurs de confiance dans `user_metadata`.
3. Activer le Custom Access Token Hook décrit plus haut et configurer l'API de test avec le JWKS URL, l'issuer et l'audience du projet.
4. Obtenir un access token depuis le compte de test. Garder l'adresse et le mot de passe dans les variables d'environnement locales, jamais dans ce dépôt :

```sh
export SUPABASE_URL='https://<project-ref>.supabase.co'
export SUPABASE_ANON_KEY='<clé-anon-du-projet-de-test>'
export TEST_USER_EMAIL='<adresse-du-compte-de-test>'
export TEST_USER_PASSWORD='<mot-de-passe-saisi-localement>'
export API_URL='http://127.0.0.1:3000'
```

```sh
curl --fail-with-body --silent --show-error \
  "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg email "$TEST_USER_EMAIL" --arg password "$TEST_USER_PASSWORD" '{email:$email,password:$password}')" \
  > /tmp/supabase-test-session.json

export ACCESS_TOKEN="$(jq -r '.access_token' /tmp/supabase-test-session.json)"
test -n "$ACCESS_TOKEN" && test "$ACCESS_TOKEN" != "null"
```

5. Décoder localement le payload du jeton et vérifier `iss`, `aud`, `sub`, `agent_id`, `tenantId`, `exp` et l'algorithme ES256 ou RS256. La validation cryptographique réelle est faite par l'API, pas par un simple décodage local.
6. Appeler une route protégée avec le jeton :

```sh
curl --fail-with-body --silent --show-error \
  "$API_URL/sync/pull" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"last_pulled_at":0,"limit":1}'
```

L'URL et le corps doivent correspondre à l'API de test réellement démarrée. Un jeton sans claims métier valides doit être refusé.

### Test manuel de non-confiance de user_metadata

Avec le même utilisateur jetable, ajouter volontairement des valeurs UUID différentes dans les champs modifiables `user_metadata.agent_id` et `user_metadata.tenantId` (via le parcours utilisateur ou un client de test). Rafraîchir la session pour obtenir un nouveau jeton, puis vérifier que les claims `agent_id` et `tenantId` correspondent toujours aux valeurs administratives de `app_metadata`, et non aux valeurs modifiables. Vérifier également que l'accès aux données d'un autre tenant reste refusé.

Ne jamais copier de mot de passe, clé service role, jeton d'accès ou secret réel dans les fichiers du dépôt ou dans un rapport de test.

Exécuter enfin `npm test -- test/idp-token.spec.ts` : mauvaise signature, HS256, claims absents et UUID mal formés doivent être rejetés.

## 4. Variables Render

- `JWKS_URL`: URL JWKS ci-dessus.
- `JWT_ISSUER`: issuer ci-dessus.
- `JWT_AUDIENCE`: `authenticated`, après confirmation.
- `JWT_SECRET`: ne pas définir cette variable en production. Le démarrage échoue si elle est présente ; le mode JWKS ne l'utilise jamais. Elle reste réservée au développement local.

## 5. Pause du projet gratuit

Le plan gratuit est réservé aux essais. Avant tout pilote commercial, prévoir le plan payant Supabase et vérifier les limites, la sauvegarde et la restauration. Le projet d'essai ne doit contenir aucune donnée réelle.
