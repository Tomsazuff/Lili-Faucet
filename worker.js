Pata Hutira:
const OWNER = "lili";

const MIN_WITHDRAWAL = 100;

const FAUCET_REWARD = 10;
const FAUCET_COOLDOWN_MS = 5 * 60 * 1000;

const PTC_BANK_SHARE = 0.50;
const PTC_MINING_SHARE = 0.50;

const WEB_SHARE = 0.95;
const USER_SHARE = 0.05;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const ALLOWED_DAYS = [1,5,10,20,30];

const PROVIDERS = [
  "adparagon",
  "coinlyads",
  "splitgrid",
  "aoyco",
  "octoclick"
];


// =====================================================
// BASIC HELPERS
// =====================================================

function now(){
  return new Date().toISOString();
}

function clean(value){
  return String(value ?? "").trim();
}

function validUserId(value){

  const id =
    clean(value).toLowerCase();

  if(
    !/^[a-z0-9_-]{3,32}$/.test(id)
  ){
    throw new Error(
      "Neplatné ID používateľa."
    );
  }

  return id;
}

function rateFor(days){

  return (
    MINING_RATES[
      Number(days)
    ] || 0
  );
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


// =====================================================
// PASSWORD
// =====================================================

async function hashPassword(password){

  const bytes =
    new TextEncoder().encode(
      String(password ?? "")
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return [
    ...new Uint8Array(digest)
  ]
    .map(
      x =>
        x.toString(16)
         .padStart(2,"0")
    )
    .join("");
}


// =====================================================
// TOKEN
// =====================================================

function randomToken(){

  const bytes =
    new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return [
    ...bytes
  ]
    .map(
      x =>
        x.toString(16)
         .padStart(2,"0")
    )
    .join("");
}

async function hashToken(token){

  return hashPassword(token);
}

async function createSession(db,userId){

  const token =
    randomToken();

  const tokenHash =
    await hashToken(token);

  const expires =
    new Date(
      Date.now() +
      30 * 24 * 60 * 60 * 1000
    ).toISOString();

  await db.prepare(
    "INSERT INTO sessions " +
    "(token_hash,user_id,expires_at,created_at) " +
    "VALUES (?,?,?,?)"
  )
  .bind(
    tokenHash,
    userId,
    expires,
    now()
  )
  .run();

  return token;
}


// =====================================================
// DATABASE SCHEMA
// =====================================================

async function ensureSchema(db){

  await db.prepare(
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      bank_sats INTEGER NOT NULL DEFAULT 0,
      mining_sats INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      password_hash TEXT,
      is_registered INTEGER NOT NULL DEFAULT 0
    )
  ).run();


  try{
    await db.prepare(
      "ALTER TABLE users ADD COLUMN password_hash TEXT"
    ).run();
  }catch(_){}


  try{
    await db.prepare(
      "ALTER TABLE users ADD COLUMN is_registered INTEGER NOT NULL DEFAULT 0"
    ).run();
  }catch(_){}


  await db.prepare(
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      referrer_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  ).run();

await db.prepare(
    CREATE TABLE IF NOT EXISTS mining_cycles (
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
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      bank_change_sats INTEGER NOT NULL DEFAULT 0,
      mining_change_sats INTEGER NOT NULL DEFAULT 0,
      reference TEXT,
      created_at TEXT NOT NULL
    )
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS ptc_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      offer_id TEXT,
      reward_sats INTEGER NOT NULL,
      bank_sats INTEGER NOT NULL,
      mining_sats INTEGER NOT NULL,
      provider_ref TEXT UNIQUE,
      created_at TEXT NOT NULL
    )
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS provider_earnings (
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
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      method TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      processed_at TEXT
    )
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS faucet_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      reward_sats INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  ).run();


  await ensureUser(db,OWNER);
}


// =====================================================
// USERS
// =====================================================

async function getUser(db,id){

  return db.prepare(
    "SELECT * FROM users WHERE id = ?"
  )
  .bind(id)
  .first();
}


async function ensureUser(db,id){

  id =
    validUserId(id);

  let user =
    await getUser(db,id);

  if(user){
    return user;
  }

  await db.prepare(
    "INSERT INTO users " +
    "(id,bank_sats,mining_sats,created_at,is_registered) " +
    "VALUES (?,0,0,?,0)"
  )
  .bind(
    id,
    now()
  )
  .run();

  return getUser(db,id);
}


// =====================================================
// REGISTER
// =====================================================

async function register(
  db,
  id,
  password,
  referrerId
){

  id =
    validUserId(id);

  password =
    String(password || "");

  if(password.length < 6){

    throw new Error(
      "Heslo musí mať minimálne 6 znakov."
    );
  }

  const existing =
    await getUser(db,id);

  if(
    existing &&
    Number(
      existing.is_registered || 0
    ) === 1
  ){

    throw new Error(
      "Tento účet už existuje."
    );
  }

  const passwordHash =
    await hashPassword(password);


  if(existing){

    await db.prepare(
      "UPDATE users SET " +
      "password_hash = ?, " +
      "is_registered = 1 " +
      "WHERE id = ?"
    )
    .bind(
      passwordHash,
      id
    )
    .run();

  }else{

    await db.prepare(
      "INSERT INTO users " +
      "(id,bank_sats,mining_sats,created_at,password_hash,is_registered) " +
      "VALUES (?,0,0,?,?,1)"
    )
    .bind(
      id,
      now(),
      passwordHash
    )
    .run();
  }


  const ref =
    clean(referrerId)
      .toLowerCase();


  if(
    ref &&
    ref !== id &&
    /^[a-z0-9_-]{3,32}$/.test(ref)
  ){

    const refUser =
      await getUser(db,ref);

    if(refUser){

const old =
        await db.prepare(
          "SELECT id FROM referrals WHERE user_id = ?"
        )
        .bind(id)
        .first();

      if(!old){

        await db.prepare(
          "INSERT INTO referrals " +
          "(user_id,referrer_id,created_at) " +
          "VALUES (?,?,?)"
        )
        .bind(
          id,
          ref,
          now()
        )
        .run();
      }
    }
  }


  const token =
    await createSession(
      db,
      id
    );

  return {
    user_id:id,
    token,
    registered:true
  };
}


// =====================================================
// LOGIN
// =====================================================

async function login(
  db,
  id,
  password
){

  id =
    validUserId(id);

  const user =
    await getUser(db,id);

  if(!user){

    throw new Error(
      "Účet neexistuje."
    );
  }

  if(
    Number(
      user.is_registered || 0
    ) !== 1
  ){

    throw new Error(
      "Účet ešte nie je registrovaný."
    );
  }

  const passwordHash =
    await hashPassword(password);

  if(
    passwordHash !==
    user.password_hash
  ){

    throw new Error(
      "Nesprávne heslo."
    );
  }

  const token =
    await createSession(
      db,
      id
    );

  return {
    user_id:id,
    token,
    logged_in:true
  };
}


// =====================================================
// AUTH
// =====================================================

async function requireAuth(
  request,
  db
){

  const header =
    request.headers.get(
      "Authorization"
    ) || "";

  if(
    !header.startsWith(
      "Bearer "
    )
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

  const token =
    header.slice(7).trim();

  if(!token){

    throw new Response(
      JSON.stringify({
        ok:false,
        error:"Chýba token."
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

  const tokenHash =
    await hashToken(token);

  const session =
    await db.prepare(
      "SELECT * FROM sessions " +
      "WHERE token_hash = ? " +
      "AND expires_at > ?"
    )
    .bind(
      tokenHash,
      now()
    )
    .first();

  if(!session){

    throw new Response(
      JSON.stringify({
        ok:false,
        error:"Relácia skončila. Prihlás sa znova."
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
    session.user_id
  );
}


// =====================================================
// MINING ACCRUAL
// =====================================================

async function accrueMining(
  db,
  userId
){

  const cycles =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? " +
      "AND status = 'active'"
    )
    .bind(userId)
    .all();

  const list =
    cycles.results || [];

  for(const cycle of list){

    const start =
      new Date(
        cycle.started_at
      ).getTime();

    const end =
      new Date(
        cycle.ends_at
      ).getTime();

    const current =
      Math.min(
        Date.now(),
        end
      );

    if(
      current <= start
    ){
      continue;
    }

    const duration =
      end - start;

    const progress =
      Math.min(
        1,
        Math.max(
          0,
          (current-start) /
          duration
        )
      );

    const principal =
      Number(
        cycle.principal_sats || 0
      );

    const target =
      Math.floor(
        principal *
        Number(cycle.rate || 0)
      );

    const earned =
      Math.floor(
        target * progress
      );

    const old =
      Number(
        cycle.earned_sats || 0
      );

    const difference =
      earned - old;

    if(difference > 0){

      await db.batch([

db.prepare(
          "UPDATE mining_cycles " +
          "SET earned_sats = ? " +
          "WHERE id = ? " +
          "AND status = 'active'"
        )
        .bind(
          earned,
          cycle.id
        ),

        db.prepare(
          "UPDATE users SET " +
          "mining_sats = mining_sats + ? " +
          "WHERE id = ?"
        )
        .bind(
          difference,
          userId
        )

      ]);
    }
  }
}


// =====================================================
// AUTO RELEASE
// =====================================================

async function autoReleaseFinishedCycles(
  db
){

  const result =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE status = 'active' " +
      "AND ends_at <= ?"
    )
    .bind(now())
    .all();

  const cycles =
    result.results || [];

  for(const cycle of cycles){

    await accrueMining(
      db,
      cycle.user_id
    );

    const fresh =
      await db.prepare(
        "SELECT * FROM mining_cycles " +
        "WHERE id = ?"
      )
      .bind(cycle.id)
      .first();

    if(
      !fresh ||
      fresh.status !== "active"
    ){
      continue;
    }

    const principal =
      Number(
        fresh.principal_sats || 0
      );

    const earned =
      Number(
        fresh.earned_sats || 0
      );

    const total =
      principal + earned;

    await db.batch([

      db.prepare(
        "UPDATE users SET " +
        "bank_sats = bank_sats + ?, " +
        "mining_sats = MAX(0,mining_sats - ?) " +
        "WHERE id = ?"
      )
      .bind(
        total,
        earned,
        fresh.user_id
      ),

      db.prepare(
        "UPDATE mining_cycles " +
        "SET status='released',released_at=? " +
        "WHERE id=?"
      )
      .bind(
        now(),
        fresh.id
      ),

      db.prepare(
        "INSERT INTO transactions " +
        "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
        "VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        fresh.user_id,
        "MINING_AUTO_RELEASE",
        total,
        total,
        -earned,
        "cycle:" + fresh.id,
        now()
      )

    ]);
  }
}


// =====================================================
// STATE
// =====================================================

async function getState(
  db,
  userId
){

  userId =
    validUserId(userId);

  await ensureUser(
    db,
    userId
  );

  await accrueMining(
    db,
    userId
  );

  await autoReleaseFinishedCycles(
    db
  );

  const user =
    await getUser(
      db,
      userId
    );

  const cycles =
    await db.prepare(
      "SELECT * FROM mining_cycles " +
      "WHERE user_id = ? " +
      "ORDER BY id DESC"
    )
    .bind(userId)
    .all();

  const referral =
    await db.prepare(
      "SELECT * FROM referrals " +
      "WHERE user_id = ?"
    )
    .bind(userId)
    .first();

  return {

    user_id:user.id,

    bank_sats:
      Number(
        user.bank_sats || 0
      ),

    mining_sats:
      Number(
        user.mining_sats || 0
      ),

    bank_btc:
      (
        Number(
          user.bank_sats || 0
        ) / 100000000
      ).toFixed(8),

    mining_btc:
      (
        Number(
          user.mining_sats || 0
        ) / 100000000
      ).toFixed(8),

    mining_rates:
      MINING_RATES,

    referral:
      referral || null,

    cycles:
      cycles.results || []
  };
}


// =====================================================
// FAUCET
// =====================================================

async function claimFaucet(
  db,
  userId
){

  userId =
    validUserId(userId);

  await ensureUser(
    db,
    userId
  );

  const last =
    await db.prepare(
      "SELECT * FROM faucet_claims " +
      "WHERE user_id = ? " +
      "ORDER BY id DESC LIMIT 1"
    )
    .bind(userId)
    .first();

  if(last){

    const lastTime =
      new Date(
        last.created_at
      ).getTime();

    const next =
      lastTime +
      FAUCET_COOLDOWN_MS;

    if(
      Date.now() < next
    ){

const error =
        new Error(
          "Faucet ešte nie je pripravený."
        );

      error.next_claim_at =
        new Date(next).toISOString();

      throw error;
    }
  }

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ? " +
      "WHERE id = ?"
    )
    .bind(
      FAUCET_REWARD,
      userId
    ),

    db.prepare(
      "INSERT INTO faucet_claims " +
      "(user_id,reward_sats,created_at) " +
      "VALUES (?,?,?)"
    )
    .bind(
      userId,
      FAUCET_REWARD,
      now()
    ),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      userId,
      "FAUCET_CLAIM",
      FAUCET_REWARD,
      FAUCET_REWARD,
      0,
      "faucet",
      now()
    )

  ]);

  return {
    reward_sats:
      FAUCET_REWARD,

    next_claim_at:
      new Date(
        Date.now() +
        FAUCET_COOLDOWN_MS
      ).toISOString()
  };
}


// =====================================================
// BANK -> MINING
// =====================================================

async function bankToMining(
  db,
  userId,
  amountSats
){

  userId =
    validUserId(userId);

  const amount =
    Math.floor(
      Number(amountSats)
    );

  if(
    !Number.isFinite(amount) ||
    amount <= 0
  ){
    throw new Error(
      "Neplatná suma."
    );
  }

  await ensureUser(
    db,
    userId
  );

  const user =
    await getUser(
      db,
      userId
    );

  if(
    Number(user.bank_sats || 0)
    < amount
  ){
    throw new Error(
      "V Banku nemáš dostatok sat."
    );
  }

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats - ?, " +
      "mining_sats = mining_sats + ? " +
      "WHERE id = ?"
    )
    .bind(
      amount,
      amount,
      userId
    ),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      userId,
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


// =====================================================
// START MINING
// =====================================================

async function startMining(
  db,
  userId,
  durationDays
){

  userId =
    validUserId(userId);

  const days =
    Number(durationDays);

  if(
    !ALLOWED_DAYS.includes(days)
  ){
    throw new Error(
      "Neplatná dĺžka mining cyklu."
    );
  }

  await ensureUser(
    db,
    userId
  );

  const user =
    await getUser(
      db,
      userId
    );

  const amount =
    Number(
      user.mining_sats || 0
    );

  if(amount <= 0){

    throw new Error(
      "V Mining nemáš žiadne sat."
    );
  }

  const rate =
    rateFor(days);

  const start =
    new Date();

  const end =
    new Date(
      start.getTime() +
      days *
      24 *
      60 *
      60 *
      1000
    );

  const result =
    await db.prepare(
      "INSERT INTO mining_cycles " +
      "(user_id,principal_sats,duration_days,rate,earned_sats,started_at,ends_at,status) " +
      "VALUES (?,?,?,?,0,?,?, 'active')"
    )
    .bind(
      userId,
      amount,
      days,
      rate,
      start.toISOString(),
      end.toISOString()
    )
    .run();

  await db.prepare(
    "INSERT INTO transactions " +
    "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
    "VALUES (?,?,?,?,?,?,?)"
  )
  .bind(
    userId,
    "MINING_START",
    amount,
    0,
    0,
    "cycle:" + result.meta.last_row_id,
    now()
  )
  .run();

  return {
    cycle_id:
      result.meta.last_row_id,

    principal_sats:
      amount,

    duration_days:
      days,

    rate,

    ends_at:
      end.toISOString()
  };
}

// =====================================================
// PTC REWARD
// =====================================================

async function addPtcReward(
  db,
  userId,
  offerId,
  rewardSats,
  providerRef
){

  userId =
    validUserId(userId);

  const reward =
    Math.floor(
      Number(rewardSats)
    );

  if(
    !Number.isFinite(reward) ||
    reward <= 0
  ){
    throw new Error(
      "Neplatná PTC odmena."
    );
  }

  const bank =
    Math.floor(
      reward *
      PTC_BANK_SHARE
    );

  const mining =
    reward - bank;

  if(providerRef){

    const duplicate =
      await db.prepare(
        "SELECT id FROM ptc_completions " +
        "WHERE provider_ref = ?"
      )
      .bind(
        clean(providerRef)
      )
      .first();

    if(duplicate){

      return {
        duplicate:true,
        completion_id:
          duplicate.id
      };
    }
  }

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ?, " +
      "mining_sats = mining_sats + ? " +
      "WHERE id = ?"
    )
    .bind(
      bank,
      mining,
      userId
    ),

    db.prepare(
      "INSERT INTO ptc_completions " +
      "(user_id,offer_id,reward_sats,bank_sats,mining_sats,provider_ref,created_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      userId,
      clean(offerId),
      reward,
      bank,
      mining,
      providerRef
        ? clean(providerRef)
        : null,
      now()
    ),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      userId,
      "PTC_REWARD",
      reward,
      bank,
      mining,
      providerRef || "ptc",
      now()
    )

  ]);

  return {
    duplicate:false,
    reward_sats:reward,
    bank_sats:bank,
    mining_sats:mining
  };
}


// =====================================================
// PROVIDER EARNING
// =====================================================

async function addProviderEarning(
  db,
  provider,
  userId,
  providerRef,
  publisherSats
){

  provider =
    clean(provider)
      .toLowerCase();

  if(
    !PROVIDERS.includes(provider)
  ){
    throw new Error(
      "Neznámy provider."
    );
  }

  userId =
    validUserId(userId);

  providerRef =
    clean(providerRef);

  if(!providerRef){

    throw new Error(
      "Chýba provider reference."
    );
  }

  const amount =
    Math.floor(
      Number(publisherSats)
    );

  if(
    !Number.isFinite(amount) ||
    amount <= 0
  ){
    throw new Error(
      "Neplatná suma provider earnings."
    );
  }

  const duplicate =
    await db.prepare(
      "SELECT * FROM provider_earnings " +
      "WHERE provider_ref = ?"
    )
    .bind(providerRef)
    .first();

  if(duplicate){

    return {
      duplicate:true,
      provider_ref:
        providerRef
    };
  }

  const webSats =
    Math.floor(
      amount *
      WEB_SHARE
    );

  const userSats =
    amount -
    webSats;

  await ensureUser(
    db,
    OWNER
  );

  if(
    userId !== OWNER
  ){
    await ensureUser(
      db,
      userId
    );
  }

  await db.batch([

    db.prepare(
      "INSERT INTO provider_earnings " +
      "(provider,user_id,provider_ref,publisher_sats,web_sats,user_sats,status,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(
      provider,
      userId,
      providerRef,
      amount,
      webSats,
      userSats,
      "confirmed",
      now()
    ),

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats + ? " +
      "WHERE id = ?"
    )
    .bind(
      webSats,
      OWNER
    ),

    db.prepare(
      "INSERT INTO transactions " +
      "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      OWNER,
      "PROVIDER_WEB_EARNING",
      webSats,
      webSats,
      0,
      provider + ":" + providerRef,
      now()
    )

  ]);

  if(
    userSats > 0 &&
    userId !== OWNER
  ){

await db.batch([

      db.prepare(
        "UPDATE users SET " +
        "bank_sats = bank_sats + ? " +
        "WHERE id = ?"
      )
      .bind(
        userSats,
        userId
      ),

      db.prepare(
        "INSERT INTO transactions " +
        "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
        "VALUES (?,?,?,?,?,?,?)"
      )
      .bind(
        userId,
        "PROVIDER_USER_REWARD",
        userSats,
        userSats,
        0,
        provider + ":" + providerRef,
        now()
      )

    ]);
  }

  return {
    duplicate:false,
    provider,
    provider_ref:providerRef,
    publisher_sats:amount,
    web_sats:webSats,
    user_sats:userSats
  };
}


// =====================================================
// PROVIDER SECURITY
// =====================================================

function checkProviderKey(
  request,
  env
){

  const secret =
    clean(
      env.PROVIDER_SECRET
    );

  if(!secret){

    return false;
  }

  const supplied =
    clean(
      request.headers.get(
        "X-Provider-Key"
      )
    );

  return supplied === secret;
}


// =====================================================
// BODY
// =====================================================

async function readBody(request){

  const type =
    request.headers.get(
      "content-type"
    ) || "";

  if(
    type.includes(
      "application/json"
    )
  ){

    return await request.json();
  }

  const form =
    await request.formData();

  const body = {};

  for(
    const [key,value]
    of form.entries()
  ){

    body[key] =
      String(value);
  }

  return body;
}


// =====================================================
// PROVIDER POSTBACK
// =====================================================

async function providerPostback(
  db,
  provider,
  request,
  env
){

  if(
    !checkProviderKey(
      request,
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

  const body =
    await readBody(
      request
    );

  const result =
    await addProviderEarning(
      db,
      provider,
      body.user_id,
      body.provider_ref,
      body.publisher_sats
    );

  return json({
    ok:true,
    ...result
  });
}


// =====================================================
// WITHDRAW
// =====================================================

async function requestWithdrawal(
  db,
  userId,
  amountSats,
  method,
  address
){

  userId =
    validUserId(userId);

  const amount =
    Math.floor(
      Number(amountSats)
    );

  if(
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL
  ){

    throw new Error(
      "Minimum výberu je " +
      MIN_WITHDRAWAL +
      " sat."
    );
  }

  const payoutMethod =
    clean(method)
      .toUpperCase();

  if(
    !["BTC","USDC"].includes(
      payoutMethod
    )
  ){

    throw new Error(
      "Neplatná mena výberu."
    );
  }

  const target =
    clean(address);

  if(!target){

    throw new Error(
      "Chýba cieľ výplaty."
    );
  }

  const user =
    await getUser(
      db,
      userId
    );

  if(!user){

    throw new Error(
      "Používateľ neexistuje."
    );
  }

  if(
    Number(
      user.bank_sats || 0
    ) < amount
  ){

    throw new Error(
      "V Banku nemáš dostatok sat."
    );
  }

  const result =
    await db.prepare(
      "INSERT INTO withdrawals " +
      "(user_id,amount_sats,method,address,status,created_at) " +
      "VALUES (?,?,?,?,?,?)"
    )
    .bind(
      userId,
      amount,
      payoutMethod,
      target,
      "pending",
      now()
    )
    .run();

  const withdrawalId =
    result.meta.last_row_id;

  await db.batch([

    db.prepare(
      "UPDATE users SET " +
      "bank_sats = bank_sats - ? " +
      "WHERE id = ?"
    )
    .bind(
      amount,
      userId
    ),

db.prepare(
      "INSERT INTO transactions " +
      "(user_id,type,amount_sats,bank_change_sats,mining_change_sats,reference,created_at) " +
      "VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      userId,
      "WITHDRAWAL_PENDING",
      amount,
      -amount,
      0,
      "withdrawal:" + withdrawalId,
      now()
    )

  ]);

  return {
    withdrawal_id:
      withdrawalId,

    amount_sats:
      amount,

    method:
      payoutMethod,

    status:
      "pending"
  };
}


// =====================================================
// TRANSACTIONS
// =====================================================

async function getTransactions(
  db,
  userId
){

  const result =
    await db.prepare(
      "SELECT id,type,amount_sats," +
      "bank_change_sats,mining_change_sats," +
      "reference,created_at " +
      "FROM transactions " +
      "WHERE user_id = ? " +
      "ORDER BY id DESC LIMIT 100"
    )
    .bind(userId)
    .all();

  return (
    result.results || []
  );
}


// =====================================================
// ROUTER
// =====================================================

async function route(
  request,
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

  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

  const method =
    request.method.toUpperCase();


  if(
    method === "OPTIONS"
  ){

    return json({
      ok:true
    });
  }


  // HEALTH
  if(
    method === "GET" &&
    path === "/"
  ){

    return json({
      ok:true,
      status:"online",
      service:"Lili Faucet Worker",
      version:"5.0.0"
    });
  }


  // REGISTER
  if(
    method === "POST" &&
    path === "/api/register"
  ){

    const body =
      await readBody(
        request
      );

    try{

      const result =
        await register(
          env.DB,
          body.user_id,
          body.password,
          body.referrer_id
        );

      return json({
        ok:true,
        ...result
      });

    }catch(error){

      return json(
        {
          ok:false,
          error:
            error.message
        },
        400
      );
    }
  }


  // LOGIN
  if(
    method === "POST" &&
    path === "/api/login"
  ){

    const body =
      await readBody(
        request
      );

    try{

      const result =
        await login(
          env.DB,
          body.user_id,
          body.password
        );

      return json({
        ok:true,
        ...result
      });

    }catch(error){

      return json(
        {
          ok:false,
          error:
            error.message
        },
        401
      );
    }
  }


  // AUTHENTICATED ROUTES
  let authUserId = null;

  const protectedPaths = [

    "/api/state",
    "/api/faucet/claim",
    "/api/bank/to-mining",
    "/api/mining/start",
    "/api/withdraw",
    "/api/transactions"

  ];

  if(
    protectedPaths.includes(path)
  ){

    try{

      authUserId =
        await requireAuth(
          request,
          env.DB
        );

    }catch(error){

      if(error instanceof Response){
        return error;
      }

      return json(
        {
          ok:false,
          error:error.message
        },
        401
      );
    }
  }


  // STATE
  if(
    method === "GET" &&
    path === "/api/state"
  ){

    return json({
      ok:true,
      ...await getState(
        env.DB,
        authUserId
      )
    });
  }


  // FAUCET
  if(
    method === "POST" &&
    path === "/api/faucet/claim"
  ){

    try{

      const result =
        await claimFaucet(
          env.DB,
          authUserId
        );

      return json({
        ok:true,
        ...result
      });

    }catch(error){

      const response = {
        ok:false,
        error:error.message
      };

      if(
        error.next_claim_at
      ){
        response.next_claim_at =
          error.next_claim_at;
      }

return json(
        response,
        429
      );
    }
  }


  // BANK -> MINING
  if(
    method === "POST" &&
    path === "/api/bank/to-mining"
  ){

    const body =
      await readBody(
        request
      );

    try{

      return json({
        ok:true,
        ...await bankToMining(
          env.DB,
          authUserId,
          body.amount_sats
        )
      });

    }catch(error){

      return json(
        {
          ok:false,
          error:error.message
        },
        400
      );
    }
  }


  // MINING START
  if(
    method === "POST" &&
    path === "/api/mining/start"
  ){

    const body =
      await readBody(
        request
      );

    try{

      return json({
        ok:true,
        ...await startMining(
          env.DB,
          authUserId,
          body.duration_days
        )
      });

    }catch(error){

      return json(
        {
          ok:false,
          error:error.message
        },
        400
      );
    }
  }


  // PROVIDER POSTBACK
  if(
    method === "POST" &&
    path.startsWith(
      "/api/provider/"
    )
  ){

    const provider =
      path
        .slice(
          "/api/provider/".length
        )
        .toLowerCase();

    return providerPostback(
      env.DB,
      provider,
      request,
      env
    );
  }


  // GENERIC PROVIDER
  if(
    method === "POST" &&
    path === "/api/provider-earning"
  ){

    if(
      !checkProviderKey(
        request,
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

    const body =
      await readBody(
        request
      );

    try{

      const result =
        await addProviderEarning(
          env.DB,
          body.provider,
          body.user_id,
          body.provider_ref,
          body.publisher_sats
        );

      return json({
        ok:true,
        ...result
      });

    }catch(error){

      return json(
        {
          ok:false,
          error:error.message
        },
        400
      );
    }
  }


  // WITHDRAW
  if(
    method === "POST" &&
    path === "/api/withdraw"
  ){

    const body =
      await readBody(
        request
      );

    try{

      return json({
        ok:true,
        ...await requestWithdrawal(
          env.DB,
          authUserId,
          body.amount_sats,
          body.method,
          body.address
        )
      });

    }catch(error){

      return json(
        {
          ok:false,
          error:error.message
        },
        400
      );
    }
  }


  // TRANSACTIONS
  if(
    method === "GET" &&
    path === "/api/transactions"
  ){

    return json({
      ok:true,
      transactions:
        await getTransactions(
          env.DB,
          authUserId
        )
    });
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


// =====================================================
// CLOUDFLARE WORKER
// =====================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ){

    try{

      return await route(
        request,
        env
      );

    }catch(error){

      console.error(
        "Worker error:",
        error
      );

      return json(
        {
          ok:false,
          error:
            error.message ||
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

    if(!env.DB){
      return;
    }

    ctx.waitUntil(
      (async()=>{

        await ensureSchema(
          env.DB
        );

        await autoReleaseFinishedCycles(
          env.DB
        );

      })()
    );
  }

};
