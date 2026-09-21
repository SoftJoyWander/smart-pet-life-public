-- Covers the composite pet/owner foreign key used when pets are deleted or
-- ownership consistency is checked. The pet_id primary key alone is not
-- considered a complete covering index by the database advisor.
create index if not exists active_walk_leases_pet_owner_fk_idx
  on private.active_walk_leases(pet_id, owner_id);
