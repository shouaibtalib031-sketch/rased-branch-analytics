-- PostgreSQL schema — منصة رصد
create extension if not exists "pgcrypto";

create type branch_status as enum ('excellent','good','medium','weak','danger');
create type severity as enum ('low','medium','high','critical');
create type observation_state as enum ('new','in_progress','overdue','completed','rejected','revisit_required','closed');
create type visit_state as enum ('processing','review','approved','rejected');

create table roles (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  name_ar text not null
);
create table permissions (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  description_ar text not null
);
create table role_permissions (
  role_id uuid references roles on delete cascade,
  permission_id uuid references permissions on delete cascade,
  primary key(role_id, permission_id)
);
create table users (
  id uuid primary key default gen_random_uuid(),
  role_id uuid references roles,
  full_name text not null,
  email text unique not null,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table regions (
  id uuid primary key default gen_random_uuid(),
  name text unique not null
);
create table branches (
  id uuid primary key default gen_random_uuid(),
  region_id uuid references regions,
  name text not null,
  city text not null,
  code text unique,
  current_score numeric(5,2),
  current_status branch_status,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table supervisors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references users,
  employee_code text unique,
  active boolean not null default true,
  normalized_name text unique
);
create table reports (
  id uuid primary key default gen_random_uuid(),
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  storage_path text not null,
  status text not null default 'uploaded',
  uploaded_by uuid references users,
  created_at timestamptz not null default now()
);
create table operational_items (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  weight numeric(6,3) not null default 1,
  safety_critical boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0
);
create table visits (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports,
  branch_id uuid not null references branches,
  supervisor_id uuid references supervisors,
  visit_date date not null,
  final_score numeric(5,2) check(final_score between 0 and 100),
  previous_score numeric(5,2),
  delta numeric(6,2) generated always as (final_score - previous_score) stored,
  status branch_status,
  workflow_state visit_state not null default 'processing',
  source_file_key text,
  source_file_name text,
  extraction_confidence numeric(5,2),
  approved_by uuid references users,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index visits_branch_date_idx on visits(branch_id, visit_date desc);
create table visit_items (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits on delete cascade,
  item_id uuid not null references operational_items,
  score numeric(5,2) not null check(score between 0 and 100),
  notes text,
  previous_score numeric(5,2),
  unique(visit_id,item_id)
);
create table observations (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits on delete cascade,
  visit_item_id uuid references visit_items on delete set null,
  category text not null,
  body text not null,
  severity severity not null,
  state observation_state not null default 'new',
  is_repeated boolean not null default false,
  repetition_count integer not null default 1,
  assignee_id uuid references users,
  due_at timestamptz,
  management_comment text,
  branch_comment text,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index observations_state_due_idx on observations(state,due_at);
create table observation_images (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references observations on delete cascade,
  kind text not null check(kind in ('evidence','before','after')),
  storage_key text not null,
  created_by uuid references users,
  created_at timestamptz not null default now()
);
create table branch_warnings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches on delete cascade,
  visit_id uuid references visits on delete set null,
  report_id uuid references reports on delete set null,
  supervisor_id uuid references supervisors on delete set null,
  warning_date date not null,
  reason text,
  item_name text,
  question_number text,
  report_number text,
  warning_text text not null,
  created_at timestamptz not null default now()
);
create index branch_warnings_branch_date_idx on branch_warnings(branch_id,warning_date desc);
create table ai_analysis (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits on delete cascade,
  model text not null,
  prompt_version text not null,
  summary text,
  strengths jsonb not null default '[]',
  weaknesses jsonb not null default '[]',
  urgency boolean not null default false,
  structured_output jsonb not null,
  created_at timestamptz not null default now()
);
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits on delete cascade,
  audience text not null check(audience in ('management','supervisor','branch')),
  body text not null,
  intervention_type text,
  approved_by uuid references users,
  approved_at timestamptz
);
create table branch_monthly_summary (
  branch_id uuid references branches on delete cascade,
  month date not null,
  visits_count integer not null,
  average_score numeric(5,2),
  highest_score numeric(5,2),
  lowest_score numeric(5,2),
  delta numeric(6,2),
  summary jsonb not null default '{}',
  primary key(branch_id,month)
);
create table branch_quarterly_summary (
  branch_id uuid references branches on delete cascade,
  year integer not null,
  quarter smallint not null check(quarter between 1 and 4),
  visits_count integer not null,
  average_score numeric(5,2),
  summary jsonb not null default '{}',
  primary key(branch_id,year,quarter)
);
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users on delete cascade,
  type text not null,
  title text not null,
  body text,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create table audit_logs (
  id bigserial primary key,
  actor_id uuid references users,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  ip inet,
  created_at timestamptz not null default now()
);
create table login_logs (
  id bigserial primary key,
  user_id uuid references users,
  email text,
  success boolean not null,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create table timeline_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branches on delete cascade,
  visit_id uuid references visits on delete cascade,
  observation_id uuid references observations on delete cascade,
  event_type text not null,
  title text not null,
  details jsonb not null default '{}',
  actor_id uuid references users,
  created_at timestamptz not null default now()
);
create table observation_workflow (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid references observations on delete cascade,
  from_state text,
  to_state text not null,
  actor_id uuid references users,
  comment text,
  created_at timestamptz not null default now()
);
create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users,
  question text not null,
  answer text not null,
  context jsonb not null default '{}',
  model text not null,
  created_at timestamptz not null default now()
);
create table scheduled_reports (
  id uuid primary key default gen_random_uuid(),
  frequency text not null,
  period_start date,
  period_end date,
  status text not null default 'pending',
  storage_path text,
  summary jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index timeline_branch_date_idx on timeline_events(branch_id,created_at desc);
create index audit_entity_date_idx on audit_logs(entity_type,entity_id,created_at desc);

insert into roles(name,name_ar) values
('system_admin','مدير النظام'),('operations_manager','مدير التشغيل'),
('supervisor','المراقب'),('branch_manager','مسؤول الفرع'),('executive','الإدارة العليا')
on conflict do nothing;
