-- Backend-only cache: metadata in Postgres, immutable image bytes in Storage.
create table public.map_snapshots (
    id text primary key check (id ~ '^[a-f0-9]{32}$'),
    cache_key text not null,
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    expires double precision not null,
    refresh_at double precision not null,
    created double precision not null,
    ready boolean not null default false
);
create index map_snapshots_cache_key on public.map_snapshots (cache_key, created desc);
create index map_snapshots_retention on public.map_snapshots (refresh_at);

create table public.map_tiles (
    snapshot text not null references public.map_snapshots(id) on delete cascade,
    z integer not null check (z between 0 and 22),
    x integer not null check (x >= 0 and x < (1::bigint << z)),
    y integer not null check (y >= 0 and y < (1::bigint << z)),
    mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
    sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
    size integer not null check (size between 1 and 5242880),
    primary key (snapshot, z, x, y)
);
create table public.map_rate_limits (
    source text primary key,
    retry_at double precision not null,
    delay double precision not null
);

alter table public.map_snapshots enable row level security;
alter table public.map_tiles enable row level security;
alter table public.map_rate_limits enable row level security;
revoke all on public.map_snapshots, public.map_tiles, public.map_rate_limits from anon, authenticated;
grant select, insert, update, delete on public.map_snapshots, public.map_tiles, public.map_rate_limits to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('map-cache', 'map-cache', false, 5242880, array['image/png','image/jpeg','image/webp']);
