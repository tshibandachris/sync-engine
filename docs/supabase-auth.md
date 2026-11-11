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

Activer ce hook dans **Authentication → Hooks → Custom Access Token**. Les valeurs `app_metadata` doivent être écrites par un processus d'administration fiable utilisant le service role ou une opération backend autorisée. Ne jamais exposer la clé service role dans le client.

## 3. Tests obligatoires avant ouverture

- Obtenir un access token du projet et vérifier `iss`, `aud`, `sub`, `agent_id`, `tenantId` et son algorithme.
- Vérifier que la clé publique du JWKS correspond à la clé de signature active.
- Vérifier qu'un utilisateur sans les deux claims ne peut pas appeler l'API.
- Vérifier qu'un changement de `user_metadata` ne modifie jamais le tenant contenu dans le token.
- Exécuter `npm test -- test/idp-token.spec.ts` : mauvaise signature, HS256, claims absents et UUID mal formés doivent être rejetés.

## 4. Variables Render

- `JWKS_URL`: URL JWKS ci-dessus.
- `JWT_ISSUER`: issuer ci-dessus.
- `JWT_AUDIENCE`: `authenticated`, après confirmation.
- `JWT_SECRET`: le bootstrap actuel le demande encore même en mode JWKS ; fournir une valeur aléatoire forte. Il ne sert pas à signer les tokens Supabase.

## 5. Pause du projet gratuit

Le plan gratuit est réservé aux essais. Avant tout pilote commercial, prévoir le plan payant Supabase et vérifier les limites, la sauvegarde et la restauration. Le projet d'essai ne doit contenir aucune donnée réelle.
