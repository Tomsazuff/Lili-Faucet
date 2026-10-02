Pata Hutira:
const OWNER="lili";

const MIN_WITHDRAWAL=100;

const PTC_BANK_SHARE=0.50;

const WEB_SHARE=0.95;
const USER_SHARE=0.05;

const MINING_RATES={
  1:0.0067,
  5:0.0333,
  10:0.08,
  20:0.1667,
  30:0.2667
};

const ALLOWED_DAYS=[
  1,
  5,
  10,
  20,
  30
];

const PROVIDERS=[
  "aoyco",
  "octoclick"
];


function now(){
 return new Date().toISOString();
}


function clean(v){
 return String(v??"").trim();
}


function validUserId(v){

 const id=
  clean(v).toLowerCase();

 if(
  !/^[a-z0-9_-]{3,32}$/.test(id)
 ){

  throw new Error(
   "Neplatné ID používateľa."
  );

 }

 return id;

}


function json(data,status=200){

 return new Response(
  JSON.stringify(data),
  {
   status,
   headers:{
    "Content-Type":
     "application/json; charset=UTF-8",

    "Access-Control-Allow-Origin":
     "*",

    "Access-Control-Allow-Methods":
     "GET,POST,OPTIONS",

    "Access-Control-Allow-Headers":
     "Content-Type, Authorization, X-Provider-Key"
   }
  }
 );

}


async function readBody(r){

 const ct=
  r.headers.get("content-type")||"";

 if(
  ct.includes("application/json")
 ){

  return await r.json();

 }

 const f=
  await r.formData();

 return Object.fromEntries(
  f.entries()
 );

}


async function hash(s){

 const b=
  new TextEncoder().encode(
   String(s??"")
  );

 const h=
  await crypto.subtle.digest(
   "SHA-256",
   b
  );

 return [
  ...new Uint8Array(h)
 ]
 .map(
  x=>x.toString(16).padStart(2,"0")
 )
 .join("");

}


function randomToken(){

 const b=
  new Uint8Array(32);

 crypto.getRandomValues(b);

 return [
  ...b
 ]
 .map(
  x=>x.toString(16).padStart(2,"0")
 )
 .join("");

}


async function hashToken(t){

 return hash(t);

}


async function createSession(
 db,
 userId
){

 const t=
  randomToken();

 const h=
  await hashToken(t);

 const e=
  new Date(
   Date.now()+
   30*86400000
  ).toISOString();

 await db
  .prepare(
   INSERT INTO sessions
    (token_hash,user_id,expires_at,created_at)
    VALUES(?,?,?,?)
  )
  .bind(
   h,
   userId,
   e,
   now()
  )
  .run();

 return t;

}


async function ensureSchema(db){

 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    bank_sats INTEGER NOT NULL DEFAULT 0,
    mining_sats INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    password_hash TEXT,
    is_registered INTEGER NOT NULL DEFAULT 0
   )
  )
  .run();

 try{

  await db
   .prepare(
    "ALTER TABLE users ADD COLUMN password_hash TEXT"
   )
   .run();

 }catch(_){}


 try{

  await db
   .prepare(
    "ALTER TABLE users ADD COLUMN is_registered INTEGER NOT NULL DEFAULT 0"
   )
   .run();

 }catch(_){}


 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
   )
  )
  .run();


 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS referrals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,
    referrer_id TEXT NOT NULL,
    created_at TEXT NOT NULL
   )
  )
  .run();


 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS mining_cycles(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    principal_sats INTEGER NOT NULL,
    duration_days INTEGER NOT NULL,
    rate REAL NOT NULL,
    earned_sats INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    released_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
   )
  )
  .run();


 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS transactions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_sats INTEGER NOT NULL,
    bank_change_sats INTEGER NOT NULL DEFAULT 0,
    mining_change_sats INTEGER NOT NULL DEFAULT 0,
    reference TEXT,
    created_at TEXT NOT NULL
   )
  )
  .run();

await db
  .prepare(
   CREATE TABLE IF NOT EXISTS provider_earnings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    user_id TEXT,
    provider_ref TEXT UNIQUE NOT NULL,
    publisher_sats INTEGER NOT NULL,
    web_sats INTEGER NOT NULL,
    user_sats INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL
   )
  )
  .run();


 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS ptc_completions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    offer_id TEXT,
    reward_sats INTEGER NOT NULL,
    bank_sats INTEGER NOT NULL,
    mining_sats INTEGER NOT NULL,
    provider_ref TEXT UNIQUE,
    created_at TEXT NOT NULL
   )
  )
  .run();


 await db
  .prepare(
   CREATE TABLE IF NOT EXISTS withdrawals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount_sats INTEGER NOT NULL,
    method TEXT NOT NULL,
    address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    processed_at TEXT
   )
  )
  .run();


 await ensureUser(
  db,
  OWNER
 );

}


async function getUser(
 db,
 id
){

 return db
  .prepare(
   "SELECT * FROM users WHERE id=?"
  )
  .bind(id)
  .first();

}


async function ensureUser(
 db,
 id
){

 id=
  validUserId(id);

 let u=
  await getUser(db,id);

 if(!u){

  await db
   .prepare(
    INSERT INTO users
     (id,bank_sats,mining_sats,created_at,is_registered)
     VALUES(?,0,0,?,0)
   )
   .bind(
    id,
    now()
   )
   .run();

  u=
   await getUser(
    db,
    id
   );

 }

 return u;

}


async function register(
 db,
 id,
 password,
 ref
){

 id=
  validUserId(id);

 password=
  String(password||"");

 if(password.length<6){

  throw new Error(
   "Heslo musí mať minimálne 6 znakov."
  );

 }

 const old=
  await getUser(
   db,
   id
  );

 if(
  old &&
  Number(old.is_registered||0)===1
 ){

  throw new Error(
   "Tento účet už existuje."
  );

 }

 const ph=
  await hash(password);

 if(old){

  await db
   .prepare(
    UPDATE users
     SET password_hash=?,
         is_registered=1
     WHERE id=?
   )
   .bind(
    ph,
    id
   )
   .run();

 }else{

  await db
   .prepare(
    INSERT INTO users
     (id,bank_sats,mining_sats,created_at,password_hash,is_registered)
     VALUES(?,0,0,?,?,1)
   )
   .bind(
    id,
    now(),
    ph
   )
   .run();

 }

 ref=
  clean(ref).toLowerCase();

 if(
  ref &&
  ref!==id &&
  /^[a-z0-9_-]{3,32}$/.test(ref)
 ){

  const ru=
   await getUser(
    db,
    ref
   );

  const rr=
   await db
    .prepare(
     "SELECT id FROM referrals WHERE user_id=?"
    )
    .bind(id)
    .first();

  if(
   ru &&
   !rr
  ){

   await db
    .prepare(
     INSERT INTO referrals
      (user_id,referrer_id,created_at)
      VALUES(?,?,?)
    )
    .bind(
     id,
     ref,
     now()
    )
    .run();

  }

 }

 return {
  user_id:id,
  token:
   await createSession(
    db,
    id
   ),
  registered:true
 };

}


async function login(
 db,
 id,
 password
){

 id=
  validUserId(id);

 const u=
  await getUser(
   db,
   id
  );

 if(
  !u ||
  Number(u.is_registered||0)!==1
 ){

  throw new Error(
   "Účet neexistuje alebo ešte nie je registrovaný."
  );

 }

 if(
  await hash(password)!==
  u.password_hash
 ){

  throw new Error(
   "Nesprávne heslo."
  );

 }

 return {
  user_id:id,
  token:
   await createSession(
    db,
    id
   ),
  logged_in:true
 };

}


async function requireAuth(
 r,
 db
){

 const h=
  r.headers.get(
   "Authorization"
  )||"";

 if(
  !h.startsWith("Bearer ")
 ){

  throw new Response(
   JSON.stringify({
    ok:false,
    error:"Nie si prihlásený."
   }),
   {
    status:401,
    headers:{
     "Content-Type":
      "application/json"
    }
   }
  );

 }

 const th=
  await hashToken(
   h.slice(7).trim()
  );

 const s=
  await db
   .prepare(
    SELECT *
     FROM sessions
     WHERE token_hash=?
     AND expires_at > ?
   )
   .bind(
    th,
    now()
   )
   .first();

 if(!s){

throw new Response(
   JSON.stringify({
    ok:false,
    error:
     "Relácia skončila. Prihlás sa znova."
   }),
   {
    status:401,
    headers:{
     "Content-Type":
      "application/json"
    }
   }
  );

 }

 return validUserId(
  s.user_id
 );

}


async function accrueMining(
 db,
 userId
){

 const q=
  await db
   .prepare(
    SELECT *
     FROM mining_cycles
     WHERE user_id=?
     AND status='active'
   )
   .bind(userId)
   .all();

 for(
  const c of q.results||[]
 ){

  const start=
   new Date(
    c.started_at
   ).getTime();

  const end=
   new Date(
    c.ends_at
   ).getTime();

  const progress=
   Math.min(
    1,
    Math.max(
     0,
     (
      Math.min(
       Date.now(),
       end
      )-
      start
     )/
     (end-start)
    )
   );

  const target=
   Math.floor(
    Number(c.principal_sats||0)*
    Number(c.rate||0)
   );

  const earned=
   Math.floor(
    target*progress
   );

  const old=
   Number(
    c.earned_sats||0
   );

  const diff=
   earned-old;

  if(diff>0){

   await db.batch([

    db
     .prepare(
      UPDATE mining_cycles
       SET earned_sats=?
       WHERE id=?
       AND status='active'
     )
     .bind(
      earned,
      c.id
     ),

    db
     .prepare(
      UPDATE users
       SET mining_sats=mining_sats+?
       WHERE id=?
     )
     .bind(
      diff,
      userId
     )

   ]);

  }

 }

}


async function autoRelease(
 db
){

 const q=
  await db
   .prepare(
    SELECT *
     FROM mining_cycles
     WHERE status='active'
     AND ends_at<=?
   )
   .bind(
    now()
   )
   .all();

 for(
  const c of q.results||[]
 ){

  await accrueMining(
   db,
   c.user_id
  );

  const f=
   await db
    .prepare(
     SELECT *
      FROM mining_cycles
      WHERE id=?
      AND status='active'
    )
    .bind(c.id)
    .first();

  if(!f)continue;

  const total=
   Number(f.principal_sats||0)+
   Number(f.earned_sats||0);

  const earned=
   Number(f.earned_sats||0);

  await db.batch([

   db
    .prepare(
     UPDATE users
      SET bank_sats=bank_sats+?,
          mining_sats=MAX(
           0,
           mining_sats-?
          )
      WHERE id=?
    )
    .bind(
     total,
     earned,
     f.user_id
    ),

   db
    .prepare(
     UPDATE mining_cycles
      SET status='released',
          released_at=?
      WHERE id=?
    )
    .bind(
     now(),
     f.id
    ),

   db
    .prepare(
     INSERT INTO transactions
      (user_id,type,amount_sats,
       bank_change_sats,
       mining_change_sats,
       reference,created_at)
      VALUES(?,?,?,?,?,?,?)
     )
    .bind(
     f.user_id,
     "MINING_AUTO_RELEASE",
     total,
     total,
     -earned,
     "cycle:"+f.id,
     now()
    )

  ]);

 }

}


async function state(
 db,
 id
){

 await ensureUser(
  db,
  id
 );

 await accrueMining(
  db,
  id
 );

 await autoRelease(
  db
 );

 const u=
  await getUser(
   db,
   id
  );

 const c=
  await db
   .prepare(
    SELECT *
     FROM mining_cycles
     WHERE user_id=?
     ORDER BY id DESC
   )
   .bind(id)
   .all();

 return {
  user_id:id,

  bank_sats:
   Number(
    u.bank_sats||0
   ),

  mining_sats:
   Number(
    u.mining_sats||0
   ),

  mining_rates:
   MINING_RATES,

  cycles:
   c.results||[]
 };

}


async function bankToMining(
 db,
 id,
 amount
){

 amount=
  Math.floor(
   Number(amount)
  );

 if(
  !Number.isFinite(amount)||
  amount<=0
 ){

  throw new Error(
   "Neplatná suma."
  );

 }

 const u=
  await getUser(
   db,
   id
  );

 if(
  Number(u.bank_sats||0)<
  amount
 ){

  throw new Error(
   "V Banku nemáš dostatok sat."
  );

 }

 await db.batch([

  db
   .prepare(
    UPDATE users
     SET bank_sats=bank_sats-?,
         mining_sats=mining_sats+?
     WHERE id=?
   )
   .bind(
    amount,
    amount,
    id
   ),

db
   .prepare(
    INSERT INTO transactions
     (user_id,type,amount_sats,
      bank_change_sats,
      mining_change_sats,
      reference,created_at)
     VALUES(?,?,?,?,?,?,?)
   )
   .bind(
    id,
    "BANK_TO_MINING",
    amount,
    -amount,
    amount,
    "bank_to_mining",
    now()
   )

 ]);

 return {
  amount_sats:amount
 };

}


async function startMining(
 db,
 id,
 days
){

 days=
  Number(days);

 if(
  !ALLOWED_DAYS.includes(days)
 ){

  throw new Error(
   "Povolené cykly: 1, 5, 10, 20 alebo 30 dní."
  );

 }

 await accrueMining(
  db,
  id
 );

 const u=
  await getUser(
   db,
   id
  );

 const amount=
  Number(
   u.mining_sats||0
  );

 if(amount<=0){

  throw new Error(
   "V Mining nemáš žiadne sat."
  );

 }

 const start=
  new Date();

 const end=
  new Date(
   start.getTime()+
   days*86400000
  );

 const rate=
  MINING_RATES[days];

 const r=
  await db
   .prepare(
    INSERT INTO mining_cycles
     (user_id,
      principal_sats,
      duration_days,
      rate,
      earned_sats,
      started_at,
      ends_at,
      status)
     VALUES(
      ?,?,?,?,0,?,?, 'active'
     )
   )
   .bind(
    id,
    amount,
    days,
    rate,
    start.toISOString(),
    end.toISOString()
   )
   .run();

 await db.batch([

  db
   .prepare(
    UPDATE users
     SET mining_sats=0
     WHERE id=?
   )
   .bind(id),

  db
   .prepare(
    INSERT INTO transactions
     (user_id,type,amount_sats,
      bank_change_sats,
      mining_change_sats,
      reference,created_at)
     VALUES(?,?,?,?,?,?,?)
   )
   .bind(
    id,
    "MINING_START",
    amount,
    0,
    -amount,
    "cycle:"+r.meta.last_row_id,
    now()
   )

 ]);

 return {
  cycle_id:
   r.meta.last_row_id,

  principal_sats:
   amount,

  duration_days:
   days,

  rate,

  ends_at:
   end.toISOString()
 };

}


async function providerEarning(
 db,
 provider,
 userId,
 ref,
 publisher
){

 provider=
  clean(provider)
  .toLowerCase();

 if(
  !PROVIDERS.includes(provider)
 ){

  throw new Error(
   "Povolený provider je iba Aoyco alebo OctoClick."
  );

 }

 userId=
  validUserId(
   userId
  );

 ref=
  clean(ref);

 const amount=
  Math.floor(
   Number(publisher)
  );

 if(
  !ref||
  !Number.isFinite(amount)||
  amount<=0
 ){

  throw new Error(
   "Neplatný provider postback."
  );

 }

 const dup=
  await db
   .prepare(
    SELECT id
     FROM provider_earnings
     WHERE provider_ref=?
   )
   .bind(ref)
   .first();

 if(dup){

  return {
   duplicate:true
  };

 }

 await ensureUser(
  db,
  userId
 );

 const web=
  Math.floor(
   amount*WEB_SHARE
  );

 const user=
  amount-web;

 await db.batch([

  db
   .prepare(
    INSERT INTO provider_earnings
     (provider,
      user_id,
      provider_ref,
      publisher_sats,
      web_sats,
      user_sats,
      status,
      created_at)
     VALUES(?,?,?,?,?,?,?,?)
   )
   .bind(
    provider,
    userId,
    ref,
    amount,
    web,
    user,
    "confirmed",
    now()
   ),

  db
   .prepare(
    UPDATE users
     SET bank_sats=bank_sats+?
     WHERE id=?
   )
   .bind(
    web,
    OWNER
   ),

  db
   .prepare(
    INSERT INTO transactions
     (user_id,type,amount_sats,
      bank_change_sats,
      mining_change_sats,
      reference,created_at)
     VALUES(?,?,?,?,?,?,?)
   )
   .bind(
    OWNER,
    "PROVIDER_WEB_EARNING",
    web,
    web,
    0,
    provider+":"+ref,
    now()
   )

 ]);

 if(
  user>0&&
  userId!==OWNER
 ){

  await db.batch([

   db
    .prepare(
     UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    )
    .bind(
     user,
     userId
    ),

   db
    .prepare(
     INSERT INTO transactions
      (user_id,type,amount_sats,
       bank_change_sats,
       mining_change_sats,
       reference,created_at)
      VALUES(?,?,?,?,?,?,?)
     )
    .bind(
     userId,
     "PROVIDER_USER_REWARD",
     user,
     user,
     0,
     provider+":"+ref,
     now()
    )

  ]);

 }

 return {
  duplicate:false,
  provider,
  publisher_sats:amount,
  web_sats:web,
  user_sats:user
 };

}

function providerKey(
 r,
 env
){

 return (
  clean(env.PROVIDER_SECRET)&&
  clean(
   r.headers.get(
    "X-Provider-Key"
   )
  )===
  clean(
   env.PROVIDER_SECRET
  )
 );

}


async function withdraw(
 db,
 id,
 amount,
 method,
 address
){

 amount=
  Math.floor(
   Number(amount)
  );

 if(
  !Number.isFinite(amount)||
  amount<MIN_WITHDRAWAL
 ){

  throw new Error(
   "Minimum výberu je 100 sat."
  );

 }

 address=
  clean(address);

 if(!address){

  throw new Error(
   "Chýba cieľ výplaty."
  );

 }

 const u=
  await getUser(
   db,
   id
  );

 if(
  Number(u.bank_sats||0)<
  amount
 ){

  throw new Error(
   "V Banku nemáš dostatok sat."
  );

 }

 const r=
  await db
   .prepare(
    INSERT INTO withdrawals
     (user_id,
      amount_sats,
      method,
      address,
      status,
      created_at)
     VALUES(?,?,?,?,?,?)
   )
   .bind(
    id,
    amount,
    clean(method)||"BTC",
    address,
    "pending",
    now()
   )
   .run();

 await db.batch([

  db
   .prepare(
    UPDATE users
     SET bank_sats=bank_sats-?
     WHERE id=?
   )
   .bind(
    amount,
    id
   ),

  db
   .prepare(
    INSERT INTO transactions
     (user_id,type,amount_sats,
      bank_change_sats,
      mining_change_sats,
      reference,created_at)
     VALUES(?,?,?,?,?,?,?)
   )
   .bind(
    id,
    "WITHDRAWAL",
    amount,
    -amount,
    0,
    "withdrawal:"+r.meta.last_row_id,
    now()
   )

 ]);

 return {
  withdrawal_id:
   r.meta.last_row_id,

  amount_sats:
   amount,

  status:
   "pending"

 };

}


async function route(
 r,
 env
){

 if(!env.DB){

  return json(
   {
    ok:false,
    error:
     "Cloudflare D1 binding DB nie je nastavený."
   },
   500
  );

 }

 await ensureSchema(
  env.DB
 );

 const u=
  new URL(r.url);

 const path=
  u.pathname;

 const method=
  r.method.toUpperCase();

 if(
  method==="OPTIONS"
 ){

  return json({
   ok:true
  });

 }


 if(
  method==="GET"&&
  path==="/"
 ){

  return json({
   ok:true,
   status:"online",
   service:
    "Lili Faucet Worker"
  });

 }


 if(
  method==="POST"&&
  path==="/api/register"
 ){

  const b=
   await readBody(r);

  try{

   return json({
    ok:true,
    ...await register(
     env.DB,
     b.user_id,
     b.password,
     b.referrer_id
    )
   });

  }catch(e){

   return json(
    {
     ok:false,
     error:e.message
    },
    400
   );

  }

 }


 if(
  method==="POST"&&
  path==="/api/login"
 ){

  const b=
   await readBody(r);

  try{

   return json({
    ok:true,
    ...await login(
     env.DB,
     b.user_id,
     b.password
    )
   });

  }catch(e){

   return json(
    {
     ok:false,
     error:e.message
    },
    401
   );

  }

 }


 let id;

 const protectedPaths=[

  "/api/state",

  "/api/referrals",

  "/api/bank/to-mining",

  "/api/mining/start",

  "/api/withdraw",

  "/api/transactions"

 ];


 if(
  protectedPaths.includes(path)
 ){

  try{

   id=
    await requireAuth(
     r,
     env.DB
    );

  }catch(e){

   return e instanceof Response
    ?
     e
    :
     json(
      {
       ok:false,
       error:e.message
      },
      401
     );

  }

 }


 if(
  method==="GET"&&
  path==="/api/state"
 ){

  return json({
   ok:true,
   ...await state(
    env.DB,
    id
   )
  });

 }


 if(
  method==="GET"&&
  path==="/api/referrals"
 ){

  const q=
   await env.DB
    .prepare(
     SELECT COUNT(*) AS count
      FROM referrals
      WHERE referrer_id=?
    )
    .bind(id)
    .first();

  return json({
   ok:true,
   count:
    Number(
     q?.count||0
    )
  });

 }


 if(
  method==="POST"&&
  path==="/api/bank/to-mining"
 ){

  try{

   const b=
    await readBody(r);

   return json({
    ok:true,
    ...await bankToMining(
     env.DB,
     id,
     b.amount_sats
    )
   });

  }catch(e){

   return json(
    {
     ok:false,
     error:e.message
    },
    400
   );

  }

 }


 if(
  method==="POST"&&
  path==="/api/mining/start"
 ){

  try{

   const b=
    await readBody(r);

return json({
    ok:true,
    ...await startMining(
     env.DB,
     id,
     b.duration_days
    )
   });

  }catch(e){

   return json(
    {
     ok:false,
     error:e.message
    },
    400
   );

  }

 }


 if(
  method==="POST"&&
  path==="/api/withdraw"
 ){

  try{

   const b=
    await readBody(r);

   return json({
    ok:true,
    ...await withdraw(
     env.DB,
     id,
     b.amount_sats,
     b.method,
     b.address
    )
   });

  }catch(e){

   return json(
    {
     ok:false,
     error:e.message
    },
    400
   );

  }

 }


 if(
  method==="GET"&&
  path==="/api/transactions"
 ){

  const q=
   await env.DB
    .prepare(
     SELECT
       id,
       type,
       amount_sats,
       bank_change_sats,
       mining_change_sats,
       reference,
       created_at
      FROM transactions
      WHERE user_id=?
      ORDER BY id DESC
      LIMIT 100
    )
    .bind(id)
    .all();

  return json({
   ok:true,
   transactions:
    q.results||[]
  });

 }


 if(
  method==="POST"&&
  path.startsWith(
   "/api/provider/"
  )
 ){

  if(
   !providerKey(
    r,
    env
   )
  ){

   return json(
    {
     ok:false,
     error:
      "Neplatný provider key."
    },
    401
   );

  }

  const provider=
   path.slice(
    "/api/provider/"
     .length
   );

  try{

   const b=
    await readBody(r);

   return json({
    ok:true,
    ...await providerEarning(
     env.DB,
     provider,
     b.user_id,
     b.provider_ref,
     b.publisher_sats
    )
   });

  }catch(e){

   return json(
    {
     ok:false,
     error:e.message
    },
    400
   );

  }

 }


 return json(
  {
   ok:false,
   error:
    "Endpoint neexistuje."
  },
  404
 );

}


export default {

 async fetch(
  r,
  env
 ){

  try{

   return await route(
    r,
    env
   );

  }catch(e){

   console.error(e);

   return json(
    {
     ok:false,
     error:
      e.message||
      "Interná chyba Worker."
    },
    500
   );

  }

 },


 async scheduled(
  event,
  env,
  ctx
 ){

  if(env.DB){

   ctx.waitUntil(

    (async()=>{

     await ensureSchema(
      env.DB
     );

     await autoRelease(
      env.DB
     );

    })()

   );

  }

 }

};
