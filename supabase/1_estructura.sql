-- =====================================================================
-- Matrícula INCOSAF 2027 — estructura y seguridad en Supabase
-- Pegar COMPLETO en: Supabase → SQL Editor → New query → Run
-- =====================================================================

-- ---------- Tablas ----------
create table public.personal (
  email text primary key            -- correos autorizados a usar el sistema
);

create table public.matriculas (
  id             uuid primary key default gen_random_uuid(),
  folio          integer not null unique,   -- número de "Ficha"
  fecha_registro text    not null,          -- se guarda como texto, igual que antes
  tipo           text    not null check (tipo in ('nuevo','antiguo')),
  estudiante     jsonb   not null,
  apoderado      jsonb   not null,
  suplente       jsonb,
  foto           text,                      -- foto carnet (aparte para no descargarla en cada lista)
  creada         timestamptz not null default now()
);

create table public.prematriculas (
  codigo text primary key check (codigo ~ '^[0-9]{4}$'),
  datos  jsonb not null,
  creada timestamptz not null default now()
);

create table public.nomina (
  rut    text primary key,                  -- RUT sin puntos ni guion (ej. 23652521K)
  nombre text not null,
  curso  text, edad text, comuna text, estado text
);

create sequence public.folio_seq start 1;

-- ---------- Quién es personal ----------
create or replace function public.es_personal() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.personal
                 where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.es_personal() from public;
grant execute on function public.es_personal() to authenticated;

-- ---------- Seguridad por fila (RLS) ----------
alter table public.personal       enable row level security;   -- sin políticas: nadie la lee desde el sitio
alter table public.matriculas     enable row level security;
alter table public.prematriculas  enable row level security;
alter table public.nomina         enable row level security;

create policy "personal gestiona matriculas" on public.matriculas
  for all to authenticated using (public.es_personal()) with check (public.es_personal());

create policy "personal lee prematriculas"   on public.prematriculas
  for select to authenticated using (public.es_personal());
create policy "personal borra prematriculas" on public.prematriculas
  for delete to authenticated using (public.es_personal());

create policy "personal lee nomina" on public.nomina
  for select to authenticated using (public.es_personal());

-- ---------- Siguiente número de ficha (solo personal) ----------
create or replace function public.siguiente_folio() returns integer
language plpgsql security definer set search_path = public as $$
begin
  if not public.es_personal() then raise exception 'No autorizado'; end if;
  return nextval('public.folio_seq')::integer;
end $$;
revoke all on function public.siguiente_folio() from public;
grant execute on function public.siguiente_folio() to authenticated;

-- ---------- Pre-matrícula de apoderados (pública, solo puede CREAR) ----------
create or replace function public.crear_prematricula(datos jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare cand text;
begin
  if datos is null or octet_length(datos::text) > 400000 then
    raise exception 'Datos inválidos o demasiado grandes';
  end if;
  for i in 1..30 loop
    cand := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    begin
      insert into public.prematriculas (codigo, datos) values (cand, datos);
      return cand;
    exception when unique_violation then
      null;  -- código ocupado, probar otro
    end;
  end loop;
  raise exception 'No se pudo generar un código disponible';
end $$;
revoke all on function public.crear_prematricula(jsonb) from public;
grant execute on function public.crear_prematricula(jsonb) to anon, authenticated;

-- ---------- Personal autorizado: EDITA ESTA LISTA con los correos reales ----------
-- insert into public.personal (email) values ('correo1@ejemplo.cl'), ('correo2@ejemplo.cl');

-- ---------- Para empezar las matrículas reales (borra pruebas y reinicia en la ficha 1) ----------
-- delete from public.matriculas;
-- delete from public.prematriculas;
-- alter sequence public.folio_seq restart with 1;
