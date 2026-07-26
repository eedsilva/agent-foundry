-- Applied by `supabase start` (and `supabase db reset`) after the migrations —
-- local development data, never applied to a deployed stack.
--
-- Two users, because one is not enough to prove anything about authorization:
-- the interesting assertion is that owner@example.com cannot see the other
-- account's row. Both sign in with the password `password123`.
--
-- Users are inserted directly rather than through the auth API so that a fresh
-- stack is usable without a running application. Two details are not optional:
-- the auth.identities row, because GoTrue looks the account up by identity
-- rather than by user; and the four empty token columns, because GoTrue reads
-- them into non-nullable strings and answers "Database error querying schema"
-- to every sign-in if they are left NULL.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000000a1',
  'authenticated', 'authenticated', 'owner@example.com',
  extensions.crypt('password123', extensions.gen_salt('bf')),
  now(), '', '', '', '',
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
), (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000000b2',
  'authenticated', 'authenticated', 'other@example.com',
  extensions.crypt('password123', extensions.gen_salt('bf')),
  now(), '', '', '', '',
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  id,
  id::text,
  json_build_object('sub', id::text, 'email', email, 'email_verified', true),
  'email',
  now(), now(), now()
from auth.users
where email in ('owner@example.com', 'other@example.com');

insert into public.items (id, user_id, title) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'First item'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Second item'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 'Another account''s item');
