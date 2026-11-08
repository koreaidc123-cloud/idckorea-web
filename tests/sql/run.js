// SQL 미리 실행 — 진짜 PostgreSQL 16(PGlite, 설치 없이 node 안에서 돔)에 db/*.sql 을 순서대로 넣어 봅니다.
// Supabase 에만 있는 것(vault·cron·pg_net·역할)은 흉내 냅니다. 실행: npm --prefix tests/sql install && npm --prefix tests/sql test
// SQLX="select ...;;select ..." 를 주면 마지막에 그 쿼리들도 돌려 결과를 보여 줍니다.
const {PGlite}=require('@electric-sql/pglite'); const fs=require('fs'), path=require('path');
const DB=process.argv[2]; const files=process.argv.slice(3);
const STUB=`
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create schema if not exists extensions; create schema if not exists vault; create schema if not exists cron; create schema if not exists net;
create table if not exists vault.secrets(id uuid default gen_random_uuid(), name text unique, secret text, description text);
create or replace view vault.decrypted_secrets as select id,name,secret as decrypted_secret,description from vault.secrets;
create or replace function vault.create_secret(s text,n text,d text default '') returns uuid language sql as $f$ insert into vault.secrets(name,secret,description) values(n,s,d) returning id $f$;
create table if not exists cron.job(jobid serial, jobname text unique, schedule text, command text, active bool default true);
create table if not exists cron.job_run_details(jobid int, status text, return_message text, start_time timestamptz);
create or replace function cron.schedule(n text,s text,c text) returns int language sql as $f$ insert into cron.job(jobname,schedule,command) values(n,s,c) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid $f$;
create or replace function cron.unschedule(n text) returns bool language sql as $f$ delete from cron.job where jobname=n returning true $f$;
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $f$ select 1::bigint $f$;
`;
(async()=>{
  const db=new PGlite();
  await db.exec(STUB);
  for(const f of files){
    let sql=fs.readFileSync(path.join(DB,f),'utf8');
    sql=sql.split(/\n/).map(l=>/^\s*create extension.*(pg_cron|pg_net)/i.test(l)?'-- (stub) '+l:l).join(String.fromCharCode(10));
    try{ await db.exec(sql); console.log('OK  ',f); }
    catch(e){ console.log('FAIL',f,'→',e.message, e.position?('@'+e.position+': '+sql.slice(Math.max(0,e.position-120),+e.position+60).replace(/\s+/g,' ')):''); process.exitCode=1; }
  }
  if(process.env.SQLX){ for(const q of process.env.SQLX.split(';;')){ try{ const r=await db.query(q); console.log('Q',q.slice(0,60),'→',JSON.stringify(r.rows).slice(0,300)); }catch(e){ console.log('QFAIL',q.slice(0,60),e.message);} } }
})();
