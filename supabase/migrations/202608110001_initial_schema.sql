-- Smart Pet Life initial cloud schema
-- Every pet-owned row includes both owner_id and pet_id so ownership remains
-- explicit and can be enforced by foreign keys and Row Level Security (RLS).

create extension if not exists pgcrypto;

create type public.care_record_kind as enum (
  'meal',
  'water',
  'medication',
  'stool',
  'urine',
  'vaccine',
  'medical'
);

create type public.record_source as enum (
  'manual',
  'medication_reminder',
  'ai_verification'
);

create type public.medication_reminder_status as enum (
  'pending',
  'completed',
  'skipped',
  'cancelled'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 40),
  species text not null default 'dog' check (species in ('dog')),
  breed text not null,
  sex text not null check (sex in ('male', 'female', 'unknown')),
  sterilization_status text not null default 'unknown'
    check (sterilization_status in ('sterilized', 'not_sterilized', 'unknown')),
  birthday date,
  weight_kg numeric(6, 2) check (weight_kg is null or weight_kg > 0),
  meals_per_day smallint not null default 2 check (meals_per_day between 1 and 10),
  water_goal_ml integer not null default 500 check (water_goal_ml between 50 and 10000),
  avatar_icon text,
  avatar_path text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table public.medication_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  pet_id uuid not null,
  title text not null check (char_length(trim(title)) between 1 and 100),
  dose text not null check (char_length(trim(dose)) between 1 and 100),
  times time[] not null check (cardinality(times) between 1 and 6),
  start_date date not null,
  end_date date not null,
  instruction text,
  note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medication_plan_date_range check (end_date >= start_date),
  constraint medication_plans_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id),
  unique (id, pet_id, owner_id)
);

create table public.care_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  pet_id uuid not null,
  kind public.care_record_kind not null,
  occurred_at timestamptz not null default now(),
  source public.record_source not null default 'manual',
  amount numeric(10, 2),
  unit text,
  food_type text check (food_type is null or food_type in ('dry', 'wet', 'canned')),
  medication_name text,
  medication_dose text,
  stool_texture text check (stool_texture is null or stool_texture in ('hard', 'normal', 'soft', 'watery')),
  stool_color text check (stool_color is null or stool_color in ('chocolate_brown', 'black_tarry', 'fresh_red', 'yellow_orange', 'gray_white', 'green')),
  stool_status text check (stool_status is null or stool_status in ('normal', 'soft_stool', 'diarrhea', 'constipation')),
  urine_color text check (urine_color is null or urine_color in ('unknown', 'clear', 'light_yellow', 'dark_yellow', 'brown', 'red')),
  title text,
  note text,
  image_path text,
  medical_file_paths text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint care_records_pet_owner_fk
    foreign key (pet_id, owner_id) references public.pets(id, owner_id)
);

create table public.medication_reminders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  pet_id uuid not null,
  medication_plan_id uuid not null,
  scheduled_at timestamptz not null,
  status public.medication_reminder_status not null default 'pending',
  completed_at timestamptz,
  care_record_id uuid references public.care_records(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medication_reminders_plan_owner_fk
    foreign key (medication_plan_id, pet_id, owner_id)
    references public.medication_plans(id, pet_id, owner_id),
  unique (medication_plan_id, scheduled_at)
);

create index pets_owner_id_idx on public.pets(owner_id);
create index care_records_pet_occurred_at_idx on public.care_records(pet_id, occurred_at desc);
create index care_records_owner_occurred_at_idx on public.care_records(owner_id, occurred_at desc);
create index medication_plans_pet_active_idx on public.medication_plans(pet_id, is_active);
create index medication_reminders_pet_scheduled_at_idx on public.medication_reminders(pet_id, scheduled_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger pets_set_updated_at before update on public.pets
for each row execute function public.set_updated_at();
create trigger care_records_set_updated_at before update on public.care_records
for each row execute function public.set_updated_at();
create trigger medication_plans_set_updated_at before update on public.medication_plans
for each row execute function public.set_updated_at();
create trigger medication_reminders_set_updated_at before update on public.medication_reminders
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.pets enable row level security;
alter table public.care_records enable row level security;
alter table public.medication_plans enable row level security;
alter table public.medication_reminders enable row level security;

create policy "Owners can read their profile"
on public.profiles for select
using (id = auth.uid());

create policy "Owners can update their profile"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

create policy "Owners can create their pets"
on public.pets for insert
with check (owner_id = auth.uid());

create policy "Owners can read their pets"
on public.pets for select
using (owner_id = auth.uid());

create policy "Owners can update their pets"
on public.pets for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

-- There is intentionally no DELETE policy for pets. The app archives pets with
-- archived_at so an accidental delete/re-create cannot fragment their history.

create policy "Owners can create their care records"
on public.care_records for insert
with check (owner_id = auth.uid());

create policy "Owners can read their care records"
on public.care_records for select
using (owner_id = auth.uid());

create policy "Owners can update their care records"
on public.care_records for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Owners can create their medication plans"
on public.medication_plans for insert
with check (owner_id = auth.uid());

create policy "Owners can read their medication plans"
on public.medication_plans for select
using (owner_id = auth.uid());

create policy "Owners can update their medication plans"
on public.medication_plans for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Owners can create their medication reminders"
on public.medication_reminders for insert
with check (owner_id = auth.uid());

create policy "Owners can read their medication reminders"
on public.medication_reminders for select
using (owner_id = auth.uid());

create policy "Owners can update their medication reminders"
on public.medication_reminders for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('pet-media', 'pet-media', false)
on conflict (id) do nothing;

create policy "Owners can read their pet media"
on storage.objects for select
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Owners can upload their pet media"
on storage.objects for insert
with check (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Owners can update their pet media"
on storage.objects for update
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Owners can delete their pet media"
on storage.objects for delete
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = auth.uid()::text
);

