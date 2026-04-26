-- =============================================================
-- CRYPTOBEAT — Schema v3
-- Changes from v2:
--   - users: added is_activated, national_id_number, national_id_status,
--            date_of_birth, full_legal_name
--   - registration: no longer requires upfront payment to play
--   - Withdrawal blocked until is_activated = true (admin sets after KYC)
--   - One phone per person: already enforced by UNIQUE on phone
--   - Bet limits: MIN 500 UGX, MAX 50,000 UGX (enforced in API)
-- =============================================================

create extension if not exists "uuid-ossp";

-- =============================================================
-- USERS
-- =============================================================
create table if not exists public.users (
  id                  uuid primary key default uuid_generate_v4(),
  phone               text unique not null,           -- one number per person
  name                text not null,
  password_hash       text not null,
  network             text not null check (network in ('MTN','AIRTEL')),
  referral_code       text unique not null,
  referred_by         uuid references public.users(id),

  -- Activation & KYC
  is_verified         boolean default false,          -- email/phone confirmed
  is_activated        boolean default false,          -- admin-approved for withdrawals
  is_banned           boolean default false,

  -- KYC fields (required for withdrawal)
  national_id_number  text unique,                    -- Uganda NIN — unique per person
  national_id_status  text default 'NONE'
                        check (national_id_status in ('NONE','PENDING','APPROVED','REJECTED')),
  full_legal_name     text,                           -- as on National ID
  date_of_birth       date,                           -- age verification (18+)
  kyc_reviewed_at     timestamptz,                    -- when admin reviewed
  kyc_reviewed_by     text,                           -- admin note

  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- =============================================================
-- WALLETS
-- =============================================================
create table if not exists public.wallets (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid unique not null references public.users(id) on delete cascade,
  balance    bigint not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- =============================================================
-- TRANSACTIONS
-- =============================================================
create table if not exists public.transactions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id),
  type            text not null check (type in (
                    'DEPOSIT','WITHDRAWAL','STAKE','PAYOUT',
                    'REFERRAL_BONUS','REGISTRATION_FEE','ADMIN_CUT'
                  )),
  amount          bigint not null,
  balance_before  bigint not null,
  balance_after   bigint not null,
  reference       text unique,
  livepay_ref     text,
  status          text not null default 'PENDING' check (status in ('PENDING','SUCCESS','FAILED')),
  meta            jsonb default '{}',
  created_at      timestamptz default now()
);

-- =============================================================
-- ROUNDS
-- =============================================================
create table if not exists public.rounds (
  id              uuid primary key default uuid_generate_v4(),
  round_number    integer not null,
  phase           text not null default 'WAITING'
                    check (phase in ('WAITING','BETTING','LIVE','RESOLVING','COMPLETE')),
  betting_starts  timestamptz,
  betting_ends    timestamptz,
  live_ends       timestamptz,
  locked_price    bigint,
  final_price     bigint,
  result          text check (result in ('ABOVE','BELOW')),
  multiplier      numeric(4,2) not null default 1.50,
  total_pool      bigint default 0,
  above_pool      bigint default 0,
  below_pool      bigint default 0,
  winner_count    integer default 0,
  house_cut       bigint default 0,
  created_at      timestamptz default now(),
  completed_at    timestamptz
);

-- =============================================================
-- BETS  (min 500, max 50,000 — enforced in API layer)
-- =============================================================
create table if not exists public.bets (
  id           uuid primary key default uuid_generate_v4(),
  round_id     uuid not null references public.rounds(id),
  user_id      uuid not null references public.users(id),
  direction    text not null check (direction in ('ABOVE','BELOW')),
  stake        bigint not null check (stake >= 500 and stake <= 50000), -- gross amount user paid
  net_stake    bigint,       -- stake after rake deducted (what enters the pool)
  rake         bigint,       -- house profit taken at bet placement time
  locked_price bigint,
  multiplier   numeric(4,2), -- actual multiplier paid at resolution
  payout       bigint default 0,
  result       text default 'PENDING' check (result in ('WIN','LOSS','PENDING')),
  created_at   timestamptz default now(),
  unique(round_id, user_id)
);

-- =============================================================
-- REFERRALS
-- =============================================================
create table if not exists public.referrals (
  id           uuid primary key default uuid_generate_v4(),
  referrer_id  uuid not null references public.users(id),
  referred_id  uuid not null references public.users(id),
  bonus_amount bigint not null default 4000,
  paid         boolean default false,
  created_at   timestamptz default now()
);

-- =============================================================
-- LIVEPAY WEBHOOK LOG
-- =============================================================
create table if not exists public.livepay_webhooks (
  id           uuid primary key default uuid_generate_v4(),
  reference    text unique not null,
  payload      jsonb not null,
  processed    boolean default false,
  created_at   timestamptz default now()
);

-- =============================================================
-- INDEXES
-- =============================================================
create index if not exists idx_bets_round_id      on public.bets(round_id);
create index if not exists idx_bets_user_id       on public.bets(user_id);
create index if not exists idx_txn_user_id        on public.transactions(user_id);
create index if not exists idx_txn_reference      on public.transactions(reference);
create index if not exists idx_rounds_phase       on public.rounds(phase);
create index if not exists idx_rounds_number      on public.rounds(round_number desc);
create index if not exists idx_webhooks_ref       on public.livepay_webhooks(reference);
create index if not exists idx_users_nid          on public.users(national_id_number);
create index if not exists idx_users_activation   on public.users(is_activated, national_id_status);

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================
alter table public.users         enable row level security;
alter table public.wallets       enable row level security;
alter table public.transactions  enable row level security;
alter table public.rounds        enable row level security;
alter table public.bets          enable row level security;
alter table public.referrals     enable row level security;
alter table public.livepay_webhooks enable row level security;

create policy "users_select_own"   on public.users for select using (auth.uid()::text = id::text);
create policy "users_update_own"   on public.users for update using (auth.uid()::text = id::text);
create policy "wallets_select_own" on public.wallets for select using (
  user_id in (select id from public.users where auth.uid()::text = id::text)
);
create policy "txn_select_own"     on public.transactions for select using (
  user_id in (select id from public.users where auth.uid()::text = id::text)
);
create policy "rounds_select_all"  on public.rounds for select using (true);
create policy "bets_select_own"    on public.bets for select using (user_id::text = auth.uid()::text);
create policy "bets_insert_own"    on public.bets for insert with check (user_id::text = auth.uid()::text);
create policy "ref_select_own"     on public.referrals for select using (
  referrer_id::text = auth.uid()::text or referred_id::text = auth.uid()::text
);

-- =============================================================
-- REALTIME
-- =============================================================
alter publication supabase_realtime add table public.rounds;
alter publication supabase_realtime add table public.bets;

-- =============================================================
-- HELPER FUNCTIONS
-- =============================================================
create or replace function credit_wallet(p_user_id uuid, p_amount bigint)
returns bigint language plpgsql security definer as $$
declare new_balance bigint;
begin
  update public.wallets set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id returning balance into new_balance;
  return new_balance;
end; $$;

create or replace function debit_wallet(p_user_id uuid, p_amount bigint)
returns bigint language plpgsql security definer as $$
declare new_balance bigint; cur_balance bigint;
begin
  select balance into cur_balance from public.wallets where user_id = p_user_id;
  if cur_balance < p_amount then raise exception 'INSUFFICIENT_BALANCE'; end if;
  update public.wallets set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id returning balance into new_balance;
  return new_balance;
end; $$;

create or replace function increment_round_pool(
  p_round_id uuid, p_amount bigint, p_direction text
) returns void language plpgsql security definer as $$
begin
  update public.rounds set
    total_pool = total_pool + p_amount,
    above_pool = above_pool + case when p_direction = 'ABOVE' then p_amount else 0 end,
    below_pool = below_pool + case when p_direction = 'BELOW' then p_amount else 0 end
  where id = p_round_id;
end; $$;

-- =============================================================
-- ADMIN VIEW: KYC pending approvals
-- Run in Supabase SQL Editor to see who needs activation:
-- =============================================================
-- select id, name, phone, national_id_number, national_id_status,
--        date_of_birth, full_legal_name, created_at
-- from public.users
-- where national_id_status = 'PENDING'
-- order by created_at;
--
-- To approve a user (replace UUID):
-- update public.users
-- set is_activated = true, national_id_status = 'APPROVED',
--     kyc_reviewed_at = now(), kyc_reviewed_by = 'admin'
-- where id = 'USER_UUID_HERE';
--
-- To reject:
-- update public.users
-- set national_id_status = 'REJECTED', kyc_reviewed_at = now()
-- where id = 'USER_UUID_HERE';
-- =============================================================
