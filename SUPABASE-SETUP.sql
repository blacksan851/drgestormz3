create table if not exists public.dr_gestor_store (
  store_key text primary key,
  store_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.dr_gestor_store (store_key, store_value)
values ('app_state', '{}'::jsonb)
on conflict (store_key) do nothing;
