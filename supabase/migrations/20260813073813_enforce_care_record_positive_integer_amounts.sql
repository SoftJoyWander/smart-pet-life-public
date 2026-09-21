-- Meal and water quantities drive health trend charts. Enforce their domain at
-- the database boundary so older or alternative clients cannot store zero,
-- negative, fractional, or missing quantities. NOT VALID preserves any legacy
-- rows; PostgreSQL still enforces the constraint for new and updated rows.
alter table public.care_records
  add constraint care_records_meal_water_positive_integer_amount
  check (
    kind not in ('meal', 'water')
    or (
      amount is not null
      and amount > 0
      and amount = trunc(amount)
    )
  ) not valid;
