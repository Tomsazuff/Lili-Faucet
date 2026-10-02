Pata Hutira:
const OWNER="lili";
const MIN_WITHDRAWAL=100;
const PTC_BANK=0.5,PTC_MINING=0.5;
const WEB_SHARE=0.95,USER_SHARE=0.05;

const RATES={1:0.0067,5:0.0333,10:0.08,20:0.1667,30:0.2667};
const DAYS=[1,5,10,20,30];

const json=(data,status=200)=>new Response(JSON.stringify(data),{
  status,
  headers:{
    "Content-Type":"application/json;charset=UTF-8",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type,Authorization"
  }
});

const now=()=>new Date().toISOString();
const clean=v=>String(v??"").trim();

function userId(v){
  v=clean(v).toLowerCase();
  if(!/^[a-z0-9_-]{3,32}$/.test(v))
    throw Error("Neplatné ID používateľa.");
  return v;
}

function rate(days){
  return RATES[Number(days)]||0;
}

async function hash(password){
  const b=await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(password))
  );
  return [...new Uint8Array(b)]
    .map(x=>x.toString(16).padStart(2,"0"))
    .join("");
}


/* =====================================================
   DATABÁZA
===================================================== */

async function tables(db){

  await db.batch([

    db.prepare(
      CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,
        bank_sats INTEGER NOT NULL DEFAULT 0,
        mining_sats INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
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
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS mining_cycles(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        principal_sats INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        earned_sats INTEGER NOT NULL DEFAULT 0,
        released_at TEXT
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS referrals(
        user_id TEXT PRIMARY KEY,
        referrer_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS ptc_completions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        reward_sats INTEGER NOT NULL,
        provider_ref TEXT,
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS provider_earnings(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider_ref TEXT NOT NULL,
        publisher_sats INTEGER NOT NULL,
        web_sats INTEGER NOT NULL,
        user_sats INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT NOT NULL,
        UNIQUE(provider,provider_ref)
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS withdrawals(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        method TEXT NOT NULL,
        address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    )
  ]);

  try{
    await db.prepare(
      "ALTER TABLE users ADD COLUMN password_hash TEXT"
    ).run();
  }catch(e){}

  try{
    await db.prepare(
      "ALTER TABLE users ADD COLUMN is_registered INTEGER NOT NULL DEFAULT 0"
    ).run();
  }catch(e){}

  await ensure(db,OWNER);

  try{
    await db.prepare(
      "UPDATE users SET is_registered=1 WHERE id=?"
    ).bind(OWNER).run();
  }catch(e){}
}


/* =====================================================
   USERS
===================================================== */

async function getUser(db,id){
  return db.prepare(
    "SELECT * FROM users WHERE id=?"
  ).bind(id).first();
}

async function ensure(db,id){
  id=userId(id);

  let u=await getUser(db,id);
  if(u)return u;

  await db.prepare(
    INSERT INTO users(id,bank_sats,mining_sats,created_at)
    VALUES(?,0,0,?)
  ).bind(id,now()).run();

  return getUser(db,id);
}


/* =====================================================
   REGISTRÁCIA
===================================================== */

async function register(db,id,password,ref){

  id=userId(id);
  password=String(password||"");

  if(password.length<6)
    throw Error("Heslo musí mať minimálne 6 znakov.");

  let old=await getUser(db,id);

  if(old && Number(old.is_registered||0)===1)
    throw Error("Tento účet už existuje.");

  const ph=await hash(password);

  if(old){

    await db.prepare(
      UPDATE users
      SET password_hash=?,is_registered=1
      WHERE id=?
    ).bind(ph,id).run();

  }else{

    await db.prepare(
      INSERT INTO users(
        id,bank_sats,mining_sats,created_at,
        password_hash,is_registered
      )
      VALUES(?,0,0,?,?,1)
    ).bind(id,now(),ph).run();

  }

  ref=clean(ref).toLowerCase();

  if(ref && ref!==id){

    const r=await getUser(db,ref);

    if(r){

      const exists=await db.prepare(
        "SELECT * FROM referrals WHERE user_id=?"
      ).bind(id).first();

      if(!exists){

        await db.prepare(
          INSERT INTO referrals(
            user_id,referrer_id,created_at
          )
          VALUES(?,?,?)
        ).bind(id,ref,now()).run();

      }
    }
  }

  return {user_id:id,registered:true};
}


/* =====================================================
   PRIHLÁSENIE
===================================================== */

async function login(db,id,password){

  id=userId(id);

  const u=await getUser(db,id);

  if(!u)
    throw Error("Účet neexistuje.");

  if(Number(u.is_registered||0)!==1)
    throw Error("Účet ešte nie je registrovaný.");

  const ph=await hash(password);

  if(ph!==u.password_hash)
    throw Error("Nesprávne heslo.");

  return {user_id:id,logged_in:true};
}


/* =====================================================
   REFERRAL
===================================================== */

async function referral(db,id,ref){

  id=userId(id);
  ref=userId(ref);

  if(id===ref)
    throw Error("Nemôžeš byť vlastným referralom.");

  await ensure(db,id);
  await ensure(db,ref);

  const old=await db.prepare(
    "SELECT * FROM referrals WHERE user_id=?"
  ).bind(id).first();

  if(old)
    return {
      user_id:id,
      referrer_id:old.referrer_id,
      existing:true
    };

  await db.prepare(
    INSERT INTO referrals(user_id,referrer_id,created_at)
    VALUES(?,?,?)
  ).bind(id,ref,now()).run();

  return {
    user_id:id,
    referrer_id:ref,
    existing:false
  };
}


/* =====================================================
   MINING VÝNOS
===================================================== */

async function accrue(db,id){

  const r=await db.prepare(
    SELECT * FROM mining_cycles
    WHERE user_id=? AND status='active'
  ).bind(id).all();

  for(const c of r.results||[]){

    const days=Number(c.duration_days);
    const pct=rate(days);

    if(!pct)continue;

    const elapsed=Math.min(
      days,
      Math.max(
        0,
        (Date.now()-new Date(c.started_at).getTime())/86400000
      )
    );

    const target=Math.floor(
      Number(c.principal_sats)*
      pct*
      (elapsed/days)
    );

    const old=Number(c.earned_sats||0);
    const add=Math.max(0,target-old);

    if(add<=0)continue;

    await db.batch([

      db.prepare(
        UPDATE mining_cycles
        SET earned_sats=earned_sats+?
        WHERE id=?
      ).bind(add,c.id),

      db.prepare(
        UPDATE users
        SET mining_sats=mining_sats+?
        WHERE id=?
      ).bind(add,id),

db.prepare(
        INSERT INTO transactions(
          user_id,type,amount_sats,
          bank_change_sats,mining_change_sats,
          reference,created_at
        )
        VALUES(?,?,?,?,?,?,?)
      ).bind(
        id,
        "MINING_YIELD",
        add,
        0,
        add,
        "cycle:"+c.id,
        now()
      )
    ]);
  }
}


/* =====================================================
   AUTOMATICKÝ RELEASE
===================================================== */

async function autoRelease(db){

  const r=await db.prepare(
    SELECT * FROM mining_cycles
    WHERE status='active'
    AND ends_at<=?
    ORDER BY id
  ).bind(now()).all();

  for(const c of r.results||[]){

    const id=c.user_id;

    await ensure(db,id);
    await accrue(db,id);

    const fresh=await db.prepare(
      SELECT * FROM mining_cycles
      WHERE id=? AND status='active'
    ).bind(c.id).first();

    if(!fresh)continue;

    const principal=Number(fresh.principal_sats||0);
    const earned=Number(fresh.earned_sats||0);
    const total=principal+earned;

    await db.batch([

      db.prepare(
        UPDATE users
        SET
          bank_sats=bank_sats+?,
          mining_sats=MAX(0,mining_sats-?)
        WHERE id=?
      ).bind(total,earned,id),

      db.prepare(
        UPDATE mining_cycles
        SET status='released',released_at=?
        WHERE id=?
      ).bind(now(),fresh.id),

      db.prepare(
        INSERT INTO transactions(
          user_id,type,amount_sats,
          bank_change_sats,mining_change_sats,
          reference,created_at
        )
        VALUES(?,?,?,?,?,?,?)
      ).bind(
        id,
        "MINING_AUTO_RELEASE",
        total,
        total,
        -earned,
        "cycle:"+fresh.id,
        now()
      )
    ]);
  }
}


/* =====================================================
   STAV
===================================================== */

async function state(db,id){

  id=clean(id)||OWNER;
  id=userId(id);

  await ensure(db,id);
  await autoRelease(db);
  await accrue(db,id);

  const u=await getUser(db,id);

  const cycles=await db.prepare(
    SELECT * FROM mining_cycles
    WHERE user_id=?
    ORDER BY id DESC
  ).bind(id).all();

  const ref=await db.prepare(
    SELECT * FROM referrals
    WHERE user_id=?
  ).bind(id).first();

  const totals=await db.prepare(
    SELECT
      COALESCE(SUM(publisher_sats),0) publisher_sats,
      COALESCE(SUM(web_sats),0) web_sats,
      COALESCE(SUM(user_sats),0) user_sats
    FROM provider_earnings
    WHERE user_id=? AND status='confirmed'
  ).bind(id).first();

  return {
    user_id:u.id,
    bank_sats:Number(u.bank_sats),
    mining_sats:Number(u.mining_sats),

    bank_btc:(
      Number(u.bank_sats)/100000000
    ).toFixed(8),

    mining_btc:(
      Number(u.mining_sats)/100000000
    ).toFixed(8),

    mining_rates:RATES,

    referral:ref||null,

    provider_totals:{
      publisher_sats:Number(
        totals?.publisher_sats||0
      ),
      web_sats:Number(
        totals?.web_sats||0
      ),
      user_sats:Number(
        totals?.user_sats||0
      )
    },

    cycles:cycles.results||[]
  };
}


/* =====================================================
   SPUSTENIE MININGU
===================================================== */

async function startMining(db,id,days){

  id=userId(id);
  days=Number(days);

  if(!DAYS.includes(days))
    throw Error(
      "Povolené cykly: 1, 5, 10, 20 alebo 30 dní."
    );

  await ensure(db,id);
  await accrue(db,id);

  const u=await getUser(db,id);
  const amount=Number(u.mining_sats);

  if(amount<=0)
    throw Error("Mining zostatok je 0.");

  const start=new Date();
  const end=new Date(
    start.getTime()+days*86400000
  );

  const r=await db.prepare(
    INSERT INTO mining_cycles(
      user_id,principal_sats,started_at,
      duration_days,ends_at,status,earned_sats
    )
    VALUES(?,?,?,?,?,'active',0)
  ).bind(
    id,
    amount,
    start.toISOString(),
    days,
    end.toISOString()
  ).run();

  const cycle=r.meta.last_row_id;

  await db.batch([

db.prepare(
      UPDATE users
      SET mining_sats=0
      WHERE id=?
    ).bind(id),

    db.prepare(
      INSERT INTO transactions(
        user_id,type,amount_sats,
        bank_change_sats,mining_change_sats,
        reference,created_at
      )
      VALUES(?,?,?,?,?,?,?)
    ).bind(
      id,
      "MINING_START",
      amount,
      0,
      -amount,
      "cycle:"+cycle,
      now()
    )
  ]);

  return {
    cycle_id:cycle,
    principal_sats:amount,
    duration_days:days,
    rate:rate(days),
    ends_at:end.toISOString()
  };
}


/* =====================================================
   BANK → MINING
===================================================== */

async function bankToMining(db,id,amount){

  id=userId(id);
  amount=Math.floor(Number(amount));

  if(!Number.isFinite(amount)||amount<=0)
    throw Error("Neplatná suma.");

  await ensure(db,id);

  const u=await getUser(db,id);

  if(Number(u.bank_sats)<amount)
    throw Error("V Banku nie je dostatok prostriedkov.");

  await db.batch([

    db.prepare(`
      UPDATE users
      SET
        bank_sats=bank_sats-?,
        mining_sats=mining_sats
