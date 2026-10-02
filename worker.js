
const OWNER="lili";
const MIN_WITHDRAW=100;
const RATES={1:0.0067,5:0.0333,10:0.08,20:0.1667,30:0.2667};
const PROVIDERS={
  aoyco:{name:"Aoyco",bank:.95,ref:.05},
  octoclick:{name:"OctoClick",bank:.95,ref:.05}
};
const now=()=>Date.now();
const clean=v=>String(v??"").trim();

function json(data,status=200){
  return new Response(JSON.stringify(data),{status,headers:{
    "content-type":"application/json;charset=UTF-8",
    "access-control-allow-origin":"*",
    "access-control-allow-methods":"GET,POST,OPTIONS",
    "access-control-allow-headers":"Content-Type, Authorization, X-Provider-Secret"
  }});
}

function cors(r){
  const h=new Headers(r.headers);
  h.set("access-control-allow-origin","*");
  h.set("access-control-allow-methods","GET,POST,OPTIONS");
  h.set("access-control-allow-headers","Content-Type, Authorization, X-Provider-Secret");
  return new Response(r.body,{status:r.status,headers:h});
}

async function body(r){
  try{return await r.json()}catch{return {}}
}

async function sha(v){
  const b=await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(v??""))
  );
  return [...new Uint8Array(b)]
    .map(x=>x.toString(16).padStart(2,"0"))
    .join("");
}

function token(){
  return crypto.randomUUID()+"-"+crypto.randomUUID();
}

async function schema(db){

  await db.prepare(CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    email TEXT,
    password_hash TEXT,
    bank_sats INTEGER NOT NULL DEFAULT 0,
    mining_sats INTEGER NOT NULL DEFAULT 0,
    is_registered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )).run();

  await db.prepare(CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )).run();

  await db.prepare(CREATE TABLE IF NOT EXISTS referrals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id TEXT NOT NULL,
    referred_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )).run();

  await db.prepare(CREATE TABLE IF NOT EXISTS mining_cycles(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    principal_sats INTEGER NOT NULL,
    duration_days INTEGER NOT NULL,
    rate REAL NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    released INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )).run();

  await db.prepare(CREATE TABLE IF NOT EXISTS transactions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_sats INTEGER NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL
  )).run();

  await db.prepare(CREATE TABLE IF NOT EXISTS provider_earnings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    user_id TEXT NOT NULL,
    gross_sats INTEGER NOT NULL,
    bank_sats INTEGER NOT NULL,
    referral_sats INTEGER NOT NULL,
    provider_ref TEXT,
    created_at INTEGER NOT NULL
  )).run();

  await db.prepare(CREATE TABLE IF NOT EXISTS withdrawals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount_sats INTEGER NOT NULL,
    method TEXT NOT NULL,
    address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )).run();

  await db.prepare(
    INSERT OR IGNORE INTO users
    (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at)
    VALUES(?,?,?,?,?,?,?)
  ).bind(
    OWNER,"","",0,0,1,now()
  ).run();
}

async function getUser(db,id){
  return db.prepare(
    SELECT * FROM users WHERE id=?
  ).bind(id).first();
}

async function newSession(db,id){
  const t=token();

  await db.prepare(
    INSERT INTO sessions
    (token,user_id,created_at,expires_at)
    VALUES(?,?,?,?)
  ).bind(
    t,id,now(),now()+30*86400000
  ).run();

  return t;
}

async function auth(req,db){
  const h=req.headers.get("Authorization")||"";

  if(!h.startsWith("Bearer "))
    return null;

return db.prepare(
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at>?
  ).bind(
    h.slice(7).trim(),
    now()
  ).first();
}

async function register(db,d){

  const id=clean(d.user_id).toLowerCase();
  const email=clean(d.email).toLowerCase();
  const pass=String(d.password||"");
  const ref=clean(d.referrer_id).toLowerCase();

  if(!/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(id))
    return json({
      error:"Používateľské ID musí mať 3–64 znakov."
    },400);

  if(id===OWNER)
    return json({
      error:"Toto ID je vyhradené."
    },400);

  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({
      error:"Zadaj platný e-mail."
    },400);

  if(pass.length<6)
    return json({
      error:"Heslo musí mať aspoň 6 znakov."
    },400);

  const old=await getUser(db,id);

  if(old&&Number(old.is_registered)===1)
    return json({
      error:"Tento používateľ už existuje."
    },409);

  const byEmail=await db.prepare(
    SELECT id
    FROM users
    WHERE lower(email)=? AND is_registered=1
    LIMIT 1
  ).bind(email).first();

  if(byEmail&&byEmail.id!==id)
    return json({
      error:"Tento e-mail už existuje."
    },409);

  const ph=await sha(pass);

  if(old){
    await db.prepare(
      UPDATE users
      SET email=?,password_hash=?,is_registered=1
      WHERE id=?
    ).bind(
      email,ph,id
    ).run();
  }else{
    await db.prepare(
      INSERT INTO users
      (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at)
      VALUES(?,?,?,?,?,?,?)
    ).bind(
      id,email,ph,0,0,1,now()
    ).run();
  }

  if(ref&&ref!==id){

    const ru=await getUser(db,ref);

    if(ru&&(Number(ru.is_registered)===1||ref===OWNER)){
      await db.prepare(
        INSERT OR IGNORE INTO referrals
        (referrer_id,referred_id,created_at)
        VALUES(?,?,?)
      ).bind(
        ref,id,now()
      ).run();
    }
  }

  return json({
    ok:true,
    user_id:id,
    token:await newSession(db,id)
  });
}

async function login(db,d){

  const v=clean(d.login).toLowerCase();
  const pass=String(d.password||"");

  if(!v||!pass)
    return json({
      error:"Vyplň prihlasovacie údaje."
    },400);

  const u=await db.prepare(
    SELECT *
    FROM users
    WHERE lower(id)=? OR lower(email)=?
    LIMIT 1
  ).bind(v,v).first();

  if(!u||Number(u.is_registered)!==1)
    return json({
      error:"Nesprávne prihlasovacie údaje."
    },401);

  if(await sha(pass)!==u.password_hash)
    return json({
      error:"Nesprávne prihlasovacie údaje."
    },401);

  return json({
    ok:true,
    user_id:u.id,
    token:await newSession(db,u.id)
  });
}

async function releaseFinished(db){

  const rows=await db.prepare(
    SELECT *
    FROM mining_cycles
    WHERE released=0 AND end_at<=?
  ).bind(now()).all();

  for(const c of rows.results||[]){

    const r=await db.prepare(
      UPDATE mining_cycles
      SET released=1
      WHERE id=? AND released=0
    ).bind(c.id).run();

    if(Number(r.meta?.changes||0)!==1)
      continue;

    const profit=Math.floor(
      Number(c.principal_sats)*Number(c.rate)
    );

    const total=Number(c.principal_sats)+profit;

    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    ).bind(
      total,c.user_id
    ).run();

    await db.prepare(
      INSERT INTO transactions
      (user_id,type,amount_sats,description,created_at)
      VALUES(?,?,?,?,?)
    ).bind(
      c.user_id,
      "MINING_RELEASE",
      total,
      Mining ${c.duration_days} dní: zisk ${profit} sat,
      now()
    ).run();
  }
}

async function state(db,id){

  await releaseFinished(db);

  const u=await getUser(db,id);

  const m=await db.prepare(
    SELECT *
    FROM mining_cycles
    WHERE user_id=? AND released=0
    ORDER BY id DESC
  ).bind(id).all();

return json({
    ok:true,
    user_id:id,
    bank_sats:Number(u.bank_sats||0),
    mining_sats:Number(u.mining_sats||0),
    mining:m.results||[],
    min_withdraw:MIN_WITHDRAW,
    mining_rates:RATES
  });
}

async function bankToMining(db,id,d){

  const a=Math.floor(
    Number(d.amount_sats||0)
  );

  if(!Number.isFinite(a)||a<=0)
    return json({
      error:"Neplatná suma."
    },400);

  const r=await db.prepare(
    UPDATE users
    SET bank_sats=bank_sats-?,
        mining_sats=mining_sats+?
    WHERE id=? AND bank_sats>=?
  ).bind(
    a,a,id,a
  ).run();

  if(Number(r.meta?.changes||0)!==1)
    return json({
      error:"Na Banku nemáš dostatok satoshi."
    },400);

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES(?,?,?,?,?)
  ).bind(
    id,
    "BANK_TO_MINING",
    a,
    "Presun z Bank do Mining",
    now()
  ).run();

  return json({
    ok:true,
    amount_sats:a
  });
}

async function startMining(db,id,d){

  const days=Number(d.duration_days);
  const rate=RATES[days];

  if(!rate)
    return json({
      error:"Povolené obdobia: 1, 5, 10, 20 alebo 30 dní."
    },400);

  const u=await getUser(db,id);
  const a=Number(u.mining_sats||0);

  if(a<=0)
    return json({
      error:"V Mining nemáš žiadne sat."
    },400);

  const start=now();
  const end=start+days*86400000;

  const r=await db.prepare(
    UPDATE users
    SET mining_sats=0
    WHERE id=? AND mining_sats=?
  ).bind(
    id,a
  ).run();

  if(Number(r.meta?.changes||0)!==1)
    return json({
      error:"Mining zostatok sa zmenil, skús znova."
    },409);

  await db.prepare(
    INSERT INTO mining_cycles
    (user_id,principal_sats,duration_days,rate,
     start_at,end_at,released,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  ).bind(
    id,a,days,rate,start,end,0,now()
  ).run();

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES(?,?,?,?,?)
  ).bind(
    id,
    "MINING_START",
    a,
    Spustený mining na ${days} dní,
    now()
  ).run();

  const profit=Math.floor(a*rate);

  return json({
    ok:true,
    principal_sats:a,
    profit_sats:profit,
    total_sats:a+profit,
    duration_days:days,
    rate
  });
}

async function referrals(db,id){

  const r=await db.prepare(
    SELECT referred_id,created_at
    FROM referrals
    WHERE referrer_id=?
    ORDER BY id DESC
  ).bind(id).all();

  return json({
    ok:true,
    referral_id:id,
    count:(r.results||[]).length,
    referrals:r.results||[]
  });
}

async function history(db,id){

  const r=await db.prepare(
    SELECT id,type,amount_sats,description,created_at
    FROM transactions
    WHERE user_id=?
    ORDER BY id DESC
    LIMIT 200
  ).bind(id).all();

  return json({
    ok:true,
    transactions:r.results||[]
  });
}

async function withdraw(db,id,d){

  const a=Math.floor(
    Number(d.amount_sats||0)
  );

  const method=clean(
    d.method||"FaucetPay"
  );

  const address=clean(
    d.address
  );

  if(!Number.isFinite(a)||a<MIN_WITHDRAW)
    return json({
      error:Minimum výber je ${MIN_WITHDRAW} sat.
    },400);

  if(!address)
    return json({
      error:"Zadaj BTC/FaucetPay adresu."
    },400);

  const r=await db.prepare(
    UPDATE users
    SET bank_sats=bank_sats-?
    WHERE id=? AND bank_sats>=?
  ).bind(
    a,id,a
  ).run();

  if(Number(r.meta?.changes||0)!==1)
    return json({
      error:"Na Banku nemáš dostatok satoshi."
    },400);

  await db.prepare(
    INSERT INTO withdrawals
    (user_id,amount_sats,method,address,status,created_at)
    VALUES(?,?,?,?,?,?)
  ).bind(
    id,
    a,
    method,
    address,
    "pending",
    now()
  ).run();

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES(?,?,?,?,?)
  ).bind(
    id,
    "WITHDRAW",
    a,
    Výber ${method}: ${address},
    now()
  ).run();

  return json({
    ok:true,
    status:"pending",
    amount_sats:a
  });
}

async function providerPostback(req,env,db,name){

  const secret=
    req.headers.get("X-Provider-Secret")||"";

  if(
    !env.PROVIDER_SECRET||
    secret!==env.PROVIDER_SECRET
  )
    return json({
      error:"Unauthorized provider request."
    },401);

  const d=await body(req);

  const uid=clean(
    d.user_id||d.username
  ).toLowerCase();

  const gross=Math.floor(
    Number(
      d.amount_sats??
      d.amount??
      d.reward??
      0
    )
  );

  const pref=clean(
    d.provider_ref||
    d.reference||
    crypto.randomUUID()
  );

  if(
    !uid||
    !Number.isFinite(gross)||
    gross<=0
  )
    return json({
      error:"Neplatný provider postback."
    },400);

  const u=await getUser(db,uid);

  if(!u||Number(u.is_registered)!==1)
    return json({
      error:"Používateľ neexistuje."
    },404);

  const p=PROVIDERS[name];

  const dup=await db.prepare(
    SELECT id
    FROM provider_earnings
    WHERE provider=? AND provider_ref=?
    LIMIT 1
  ).bind(
    name,pref
  ).first();

  if(dup)
    return json({
      ok:true,
      duplicate:true
    });

  const bank=Math.floor(
    gross*p.bank
  );

  const ref=gross-bank;

  await db.prepare(
    UPDATE users
    SET bank_sats=bank_sats+?
    WHERE id=?
  ).bind(
    bank,uid
  ).run();

  const rr=await db.prepare(
    SELECT referrer_id
    FROM referrals
    WHERE referred_id=?
    LIMIT 1
  ).bind(
    uid
  ).first();

  const target=
    rr?.referrer_id||
    OWNER;

  if(ref>0){

    await db.prepare(
      UPDATE users
      SET bank_sats=bank_sats+?
      WHERE id=?
    ).bind(
      ref,target
    ).run();

    await db.prepare(
      INSERT INTO transactions
      (user_id,type,amount_sats,description,created_at)
      VALUES(?,?,?,?,?)
    ).bind(
      target,
      "REFERRAL",
      ref,
      Referral od ${p.name},
      now()
    ).run();
  }

  await db.prepare(
    INSERT INTO provider_earnings
    (provider,user_id,gross_sats,bank_sats,
     referral_sats,provider_ref,created_at)
    VALUES(?,?,?,?,?,?,?)
  ).bind(
    name,
    uid,
    gross,
    bank,
    ref,
    pref,
    now()
  ).run();

  await db.prepare(
    INSERT INTO transactions
    (user_id,type,amount_sats,description,created_at)
    VALUES(?,?,?,?,?)
  ).bind(
    uid,
    "PROVIDER",
    bank,
    ${p.name} odmena,
    now()
  ).run();

  return json({
    ok:true,
    provider:name,
    gross_sats:gross,
    bank_sats:bank,
    referral_sats:ref
  });
}

async function route(req,env){

  const db=env.DB;

  if(!db)
    return json({
      error:"D1 binding DB nie je nastavený."
    },500);

  if(req.method==="OPTIONS")
    return new Response(null,{
      status:204,
      headers:{
        "access-control-allow-origin":"*",
        "access-control-allow-methods":
          "GET,POST,OPTIONS",
        "access-control-allow-headers":
          "Content-Type, Authorization, X-Provider-Secret"
      }
    });

  await schema(db);

  const path=
    new URL(req.url).pathname;

  if(path==="/")
    return json({
      ok:true,
      name:"Lili Faucet",
      status:"online"
    });

  if(
    path==="/api/register"&&
    req.method==="POST"
  )
    return register(
      db,
      await body(req)
    );

  if(
    path==="/api/login"&&
    req.method==="POST"
  )
    return login(
      db,
      await body(req)
    );

  if(
    path==="/api/provider/aoyco"&&
    req.method==="POST"
  )
    return providerPostback(
      req,env,db,"aoyco"
    );

  if(
    path==="/api/provider/octoclick"&&
    req.method==="POST"
  )
    return providerPostback(
      req,env,db,"octoclick"
    );

  if(
    path==="/api/providers"&&
    req.method==="GET"
  )
    return json({
      ok:true,
      providers:Object.entries(PROVIDERS)
        .map(([id,p])=>({
          id,
          name:p.name,
          bank_percent:95,
          referral_percent:5
        }))
    });

  const user=
    await auth(req,db);

  if(!user)
    return json({
      error:"Nie si prihlásený."
    },401);

if(
    path==="/api/state"&&
    req.method==="GET"
  )
    return state(db,user.id);

  if(
    path==="/api/bank/to-mining"&&
    req.method==="POST"
  )
    return bankToMining(
      db,
      user.id,
      await body(req)
    );

  if(
    path==="/api/mining/start"&&
    req.method==="POST"
  )
    return startMining(
      db,
      user.id,
      await body(req)
    );

  if(
    path==="/api/referrals"&&
    req.method==="GET"
  )
    return referrals(
      db,
      user.id
    );

  if(
    path==="/api/transactions"&&
    req.method==="GET"
  )
    return history(
      db,
      user.id
    );

  if(
    path==="/api/withdraw"&&
    req.method==="POST"
  )
    return withdraw(
      db,
      user.id,
      await body(req)
    );

  if(path==="/api/logout"){

    const h=
      req.headers.get("Authorization")||"";

    if(h.startsWith("Bearer "))
      await db.prepare(
        DELETE FROM sessions
        WHERE token=?
      ).bind(
        h.slice(7).trim()
      ).run();

    return json({ok:true});
  }

  return json({
    error:"Endpoint neexistuje."
  },404);
}

export default{

  async fetch(req,env){

    try{
      return cors(
        await route(req,env)
      );
    }catch(e){
      return json({
        error:"Worker chyba.",
        detail:String(
          e?.message||e
        )
      },500);
    }
  },

  async scheduled(event,env,ctx){

    ctx.waitUntil(
      (async()=>{

        if(env.DB){
          await schema(env.DB);
          await releaseFinished(env.DB);
        }

      })()
    );
  }
};
