-- Stream new collaboration invitations to authenticated clients. Row Level
-- Security on pet_invitations still decides which signed-in user receives each row.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pet_invitations'
  ) then
    alter publication supabase_realtime add table public.pet_invitations;
  end if;
end;
$$;
