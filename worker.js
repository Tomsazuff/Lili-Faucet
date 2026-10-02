
const OWNER_USER_ID = "lili";

const MIN_WITHDRAWAL_SATS = 100;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const ALLOWED_DAYS = [1,5,10,20,30];


function json(data,status=200){

  return new Response(
    JSON.stringify(data,null,2),
    {
      status,
      headers:{
        "Content-Type":
          "application/json; charset=UTF-8",

        "Access-Control-Allow-Origin":"*",

        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type"
      }
    }
  );

}


function now(){

  return new Date().toISOString();

}


function clean(value){

  return String(value ?? "").trim();

}


function rateFor(days){

  return MINING_RATES[
    Number(days)
  ] || 0;

}


/* SHA-256 PASSWORD HASH */

async function sha256(text){

  const data=
    new TextEncoder().encode(text);

  const hash=
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return [...new Uint8Array(hash)]
    .map(
      x=>x
        .toString(16)
        .padStart(2,"0")
    )
    .join("");

}


/* DATABASE HELPERS */

async function addColumn(
  db,
  table,
  column,
  type
){

  try{

    await db
      .prepare(
        ALTER TABLE ${table}
         ADD COLUMN ${column} ${type}
      )
      .run();

  }catch(_){

  }

}


async function getUser(db,id){

  return db
    .prepare(
      "SELECT * FROM users WHERE id = ?"
    )
    .bind(id)
    .first();

}


async function ensureUser(db,id){

  id=
    clean(id)
    .toLowerCase();

  if(!id){

    throw new Error(
      "Chýba používateľské ID."
    );

  }

  let u=
    await getUser(db,id);

  if(u){

    return u;

  }

  await db
    .prepare(
      INSERT INTO users
       (
         id,
         bank_sats,
         mining_sats,
         created_at,
         password_hash,
         is_registered
       )
       VALUES
       (?,0,0,?,NULL,0)
    )
    .bind(
      id,
      now()
    )
    .run();

  return getUser(db,id);

}


/* DATABASE TABLES */

async function createTables(db){

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
      CREATE TABLE IF NOT EXISTS withdrawals(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        method TEXT NOT NULL,
        address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    ),

    db.prepare(
      CREATE TABLE IF NOT EXISTS provider_transactions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        trans_id TEXT NOT NULL,
        sub_id TEXT NOT NULL,
        reward INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider,trans_id)
      )
    )

  ]);

await addColumn(
    db,
    "users",
    "password_hash",
    "TEXT"
  );


  await addColumn(
    db,
    "users",
    "is_registered",
    "INTEGER NOT NULL DEFAULT 0"
  );


  await ensureUser(
    db,
    OWNER_USER_ID
  );


  await db
    .prepare(
      UPDATE users
       SET is_registered = 1
       WHERE id = ?
    )
    .bind(OWNER_USER_ID)
    .run();

}


/* MINING RELEASE */

async function settleMining(db,id){

  const rows=
    await db
      .prepare(
        SELECT *
         FROM mining_cycles
         WHERE user_id = ?
         AND status = 'active'
      )
      .bind(id)
      .all();


  let released=0;


  for(
    const cycle
    of (rows.results || [])
  ){

    if(
      new Date(
        cycle.ends_at
      ).getTime()
      <= Date.now()
    ){

      const principal=
        Number(
          cycle.principal_sats
        );

      const profit=
        Math.floor(
          principal *
          rateFor(
            cycle.duration_days
          )
        );

      const total=
        principal+profit;


      await db.batch([

        db.prepare(
          UPDATE mining_cycles
           SET
             status = 'completed',
             earned_sats = ?,
             released_at = ?
           WHERE id = ?
        ).bind(
          profit,
          now(),
          cycle.id
        ),

        db.prepare(
          UPDATE users
           SET bank_sats =
             bank_sats + ?
           WHERE id = ?
        ).bind(
          total,
          id
        ),

        db.prepare(
          INSERT INTO transactions
           (
             user_id,
             type,
             amount_sats,
             bank_change_sats,
             mining_change_sats,
             reference,
             created_at
           )
           VALUES
           (?,'MINING_RELEASE',?,?,0,?,?)
        ).bind(
          id,
          total,
          total,
          "cycle:"+cycle.id,
          now()
        )

      ]);


      released++;

    }

  }


  return released;

}


/* STATE */

async function getState(db,id){

  id=
    clean(id)
    .toLowerCase();

  if(!id){

    throw new Error(
      "Chýba user_id."
    );

  }


  await ensureUser(db,id);

  await settleMining(
    db,
    id
  );


  const u=
    await getUser(
      db,
      id
    );


  const cycles=
    await db
      .prepare(
        SELECT *
         FROM mining_cycles
         WHERE user_id = ?
         ORDER BY id DESC
      )
      .bind(id)
      .all();


  const transactions=
    await db
      .prepare(
        SELECT *
         FROM transactions
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 100
      )
      .bind(id)
      .all();


  const referrals=
    await db
      .prepare(
        SELECT COUNT(*) AS count
         FROM referrals
         WHERE referrer_id = ?
      )
      .bind(id)
      .first();


  return {

    user_id:id,

    bank_sats:
      Number(
        u.bank_sats || 0
      ),

    mining_sats:
      Number(
        u.mining_sats || 0
      ),

    referral_count:
      Number(
        referrals?.count || 0
      ),

    rates:
      MINING_RATES,

    cycles:
      cycles.results || [],

    transactions:
      transactions.results || []

  };

}


/* REGISTER */

async function register(
  db,
  id,
  password,
  referrer
){

  id=
    clean(id)
    .toLowerCase();

  password=
    clean(password);

  referrer=
    clean(referrer)
    .toLowerCase();


  if(
    !/^[a-z0-9_]{3,24}$/.test(id)
  ){

    throw new Error(
      "ID musí mať 3–24 znakov: a-z, 0-9 alebo _."
    );

  }


  if(password.length<6){

    throw new Error(
      "Heslo musí mať aspoň 6 znakov."
    );

  }


  if(id===OWNER_USER_ID){

    throw new Error(
      "Toto ID je vyhradené."
    );

  }


  const existing=
    await getUser(
      db,
      id
    );


  if(
    existing &&
    Number(
      existing.is_registered || 0
    )===1
  ){

    throw new Error(
      "Účet už existuje."
    );

  }


  if(referrer===id){

    referrer="";

  }


  if(referrer){

const ref=
      await getUser(
        db,
        referrer
      );


    if(
      !ref ||
      Number(
        ref.is_registered || 0
      )!==1
    ){

      referrer="";

    }

  }


  const passwordHash=
    await sha256(
      password
    );


  if(existing){

    await db
      .prepare(
        UPDATE users
         SET
           password_hash = ?,
           is_registered = 1
         WHERE id = ?
      )
      .bind(
        passwordHash,
        id
      )
      .run();

  }else{

    await db
      .prepare(
        INSERT INTO users
         (
           id,
           bank_sats,
           mining_sats,
           created_at,
           password_hash,
           is_registered
         )
         VALUES
         (?,0,0,?,?,1)
      )
      .bind(
        id,
        now(),
        passwordHash
      )
      .run();

  }


  if(referrer){

    await db
      .prepare(
        INSERT OR IGNORE INTO referrals
         (
           user_id,
           referrer_id,
           created_at
         )
         VALUES(?,?,?)
      )
      .bind(
        id,
        referrer,
        now()
      )
      .run();

  }


  return {

    user_id:id,

    referrer_id:
      referrer || null

  };

}


/* LOGIN */

async function login(
  db,
  id,
  password
){

  id=
    clean(id)
    .toLowerCase();


  const u=
    await getUser(
      db,
      id
    );


  if(
    !u ||
    Number(
      u.is_registered || 0
    )!==1
  ){

    throw new Error(
      "Účet neexistuje alebo nie je zaregistrovaný."
    );

  }


  const passwordHash=
    await sha256(
      password
    );


  if(
    passwordHash !==
    u.password_hash
  ){

    throw new Error(
      "Nesprávne heslo."
    );

  }


  return {
    user_id:id
  };

}


/* BANK -> MINING */

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
    !Number.isFinite(amount) ||
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


  if(!u){

    throw new Error(
      "Používateľ neexistuje."
    );

  }


  if(
    Number(u.bank_sats) <
    amount
  ){

    throw new Error(
      "V Banku nie je dostatok satoshi."
    );

  }


  await db.batch([

    db.prepare(
      UPDATE users
       SET
         bank_sats =
           bank_sats - ?,
         mining_sats =
           mining_sats + ?
       WHERE id = ?
    ).bind(
      amount,
      amount,
      id
    ),

    db.prepare(
      INSERT INTO transactions
       (
         user_id,
         type,
         amount_sats,
         bank_change_sats,
         mining_change_sats,
         reference,
         created_at
       )
       VALUES
       (?,'BANK_TO_MINING',?,?,?,?,?)
    ).bind(
      id,
      amount,
      -amount,
      amount,
      "bank-to-mining",
      now()
    )

  ]);


  return {
    amount_sats:amount
  };

}


/* START MINING */

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
      "Povolené sú iba 1, 5, 10, 20 alebo 30 dní."
    );

  }


  const u=
    await getUser(
      db,
      id
    );


  if(!u){

    throw new Error(
      "Používateľ neexistuje."
    );

  }


  const amount=
    Number(
      u.mining_sats || 0
    );


  if(amount<=0){

    throw new Error(
      "Mining zostatok je 0."
    );

  }


  const started=
    new Date();


  const ends=
    new Date(
      started.getTime()+
      days*86400000
    );


  const result=
    await db
      .prepare(
        INSERT INTO mining_cycles
         (
           user_id,
           principal_sats,
           started_at,
           duration_days,
           ends_at,
           status,
           earned_sats
         )
         VALUES
         (?,?,?,?,?,'active',0)
      )
      .bind(
        id,
        amount,
        started.toISOString(),
        days,
        ends.toISOString()
      )
      .run();


  const cycleId=
    result.meta.last_row_id;

await db.batch([

    db.prepare(
      UPDATE users
       SET mining_sats = 0
       WHERE id = ?
    ).bind(id),

    db.prepare(
      INSERT INTO transactions
       (
         user_id,
         type,
         amount_sats,
         bank_change_sats,
         mining_change_sats,
         reference,
         created_at
       )
       VALUES
       (?,'MINING_START',?,0,?,?,?)
    ).bind(
      id,
      amount,
      -amount,
      "cycle:"+cycleId,
      now()
    )

  ]);


  return {

    cycle_id:cycleId,

    principal_sats:
      amount,

    ends_at:
      ends.toISOString(),

    rate:
      rateFor(days)

  };

}


/* WITHDRAW */

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

  method=
    clean(method);

  address=
    clean(address);


  const u=
    await getUser(
      db,
      id
    );


  if(!u){

    throw new Error(
      "Používateľ neexistuje."
    );

  }


  if(
    !Number.isFinite(amount) ||
    amount<MIN_WITHDRAWAL_SATS
  ){

    throw new Error(
      "Minimum výberu je 100 sat."
    );

  }


  if(
    !method ||
    !address
  ){

    throw new Error(
      "Chýba spôsob alebo adresa výplaty."
    );

  }


  if(
    Number(u.bank_sats)<
    amount
  ){

    throw new Error(
      "V Banku nie je dostatok satoshi."
    );

  }


  const result=
    await db
      .prepare(
        INSERT INTO withdrawals
         (
           user_id,
           amount_sats,
           method,
           address,
           status,
           created_at
         )
         VALUES
         (?,?,?,?,'pending',?)
      )
      .bind(
        id,
        amount,
        method,
        address,
        now()
      )
      .run();


  await db.batch([

    db.prepare(
      UPDATE users
       SET bank_sats =
         bank_sats - ?
       WHERE id = ?
    ).bind(
      amount,
      id
    ),

    db.prepare(
      INSERT INTO transactions
       (
         user_id,
         type,
         amount_sats,
         bank_change_sats,
         mining_change_sats,
         reference,
         created_at
       )
       VALUES
       (?,'WITHDRAWAL',?,?,0,?,?)
    ).bind(
      id,
      amount,
      -amount,
      "withdrawal:"+result.meta.last_row_id,
      now()
    )

  ]);


  return {

    withdrawal_id:
      result.meta.last_row_id,

    amount_sats:
      amount,

    status:
      "pending"

  };

}


/* Aoyco PTC */

async function aoycoPTC(
  request,
  env
){

  const url=
    new URL(request.url);


  const apiKey=
    clean(
      env.AOYCO_API_KEY
    );


  const bearer=
    clean(
      env.AOYCO_BEARER_TOKEN ||
      env.AOYCO_TOKEN
    );


  const userId=
    clean(
      url.searchParams.get(
        "user_id"
      )
    );


  const ip=
    request.headers.get(
      "CF-Connecting-IP"
    ) ||
    "0.0.0.0";


  if(
    !apiKey ||
    !bearer
  ){

    return json(
      {
        ok:false,
        error:
          "Aoyco API kľúče nie sú nastavené vo Worker secrets."
      },
      500
    );

  }


  if(!/^[A-Za-z0-9]+$/.test(userId)){

    return json(
      {
        ok:false,
        error:
          "Aoyco USER_ID môže obsahovať iba písmená a čísla."
      },
      400
    );

  }


  const response=
    await fetch(
      "https://aoyco.in/api/v1/ptc/"
      +encodeURIComponent(apiKey)
      +"/"
      +encodeURIComponent(userId)
      +"/"
      +encodeURIComponent(ip),
      {
        method:"GET",
        headers:{
          "Authorization":
            "Bearer "+bearer
        }
      }
    );


  const text=
    await response.text();


  return new Response(
    JSON.stringify({
      ok:response.ok,
      data:text
    }),
    {
      status:response.status,
      headers:{
        "Content-Type":
          "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin":"*"
      }
    }
  );

}


/* PROVIDER CREDIT */

async function providerCredit(
  db,
  provider,
  subId,
  transId,
  reward,
  status
){

  provider=
    clean(provider);

  subId=
    clean(subId);

transId=
    clean(transId);

  reward=
    Math.floor(
      Number(reward)
    );

  status=
    clean(status || "1");


  if(
    !subId ||
    !transId ||
    !Number.isFinite(reward) ||
    reward<=0
  ){

    return {
      ignored:true
    };

  }


  const duplicate=
    await db
      .prepare(
        SELECT id
         FROM provider_transactions
         WHERE provider = ?
         AND trans_id = ?
      )
      .bind(
        provider,
        transId
      )
      .first();


  if(duplicate){

    return {
      duplicate:true
    };

  }


  await ensureUser(
    db,
    subId
  );


  const userShare=
    Math.floor(
      reward*0.05
    );


  const ownerShare=
    reward-userShare;


  await db.batch([

    db.prepare(
      INSERT INTO provider_transactions
       (
         provider,
         trans_id,
         sub_id,
         reward,
         status,
         created_at
       )
       VALUES
       (?,?,?,?,?,?)
    ).bind(
      provider,
      transId,
      subId,
      reward,
      status,
      now()
    ),

    db.prepare(
      UPDATE users
       SET bank_sats =
         bank_sats + ?
       WHERE id = ?
    ).bind(
      userShare,
      subId
    ),

    db.prepare(
      UPDATE users
       SET bank_sats =
         bank_sats + ?
       WHERE id = ?
    ).bind(
      ownerShare,
      OWNER_USER_ID
    ),

    db.prepare(
      INSERT INTO transactions
       (
         user_id,
         type,
         amount_sats,
         bank_change_sats,
         mining_change_sats,
         reference,
         created_at
       )
       VALUES
       (?,'PROVIDER_5_PERCENT',?,?,0,?,?)
    ).bind(
      subId,
      userShare,
      userShare,
      provider+":"+transId,
      now()
    ),

    db.prepare(
      INSERT INTO transactions
       (
         user_id,
         type,
         amount_sats,
         bank_change_sats,
         mining_change_sats,
         reference,
         created_at
       )
       VALUES
       (?,'PROVIDER_95_PERCENT',?,?,0,?,?)
    ).bind(
      OWNER_USER_ID,
      ownerShare,
      ownerShare,
      provider+":"+transId,
      now()
    )

  ]);


  return {

    credited:true,

    user_sats:
      userShare,

    owner_sats:
      ownerShare

  };

}


/* MAIN */

export default {

async fetch(request,env){

  if(
    request.method==="OPTIONS"
  ){

    return json(
      {},
      204
    );

  }


  if(!env.DB){

    return json(
      {
        ok:false,
        error:
          "D1 binding DB nie je pripojený."
      },
      500
    );

  }


  try{

    await createTables(
      env.DB
    );


    const url=
      new URL(request.url);


    const path=
      url.pathname
      .replace(/\/+$/,"")
      || "/";


    /* ROOT */

    if(path==="/"){

      return json({

        ok:true,

        name:
          "Lili Faucet",

        status:
          "online",

        version:
          "3.0"

      });

    }


    /* REGISTER */

    if(
      path==="/api/register" &&
      request.method==="POST"
    ){

      const body=
        await request.json();


      const result=
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

    }


    /* LOGIN */

    if(
      path==="/api/login" &&
      request.method==="POST"
    ){

      const body=
        await request.json();


      const result=
        await login(
          env.DB,
          body.user_id,
          body.password
        );


      return json({
        ok:true,
        ...result
      });

    }


    /* STATE */

    if(
      path==="/api/state" &&
      request.method==="GET"
    ){

      return json({

        ok:true,

        ...(await getState(
          env.DB,
          url.searchParams.get(
            "user_id"
          )
        ))

      });

    }


    /* BANK TO MINING */

    if(
      path==="/api/bank/to-mining" &&
      request.method==="POST"
    ){

      const body=
        await request.json();

return json({

        ok:true,

        ...(await bankToMining(
          env.DB,
          clean(body.user_id),
          body.amount_sats
        ))

      });

    }


    /* START MINING */

    if(
      path==="/api/mining/start" &&
      request.method==="POST"
    ){

      const body=
        await request.json();


      return json({

        ok:true,

        ...(await startMining(
          env.DB,
          clean(body.user_id),
          body.duration_days
        ))

      });

    }


    /* WITHDRAW */

    if(
      path==="/api/withdraw" &&
      request.method==="POST"
    ){

      const body=
        await request.json();


      return json({

        ok:true,

        ...(await withdraw(
          env.DB,
          clean(body.user_id),
          body.amount_sats,
          body.method,
          body.address
        ))

      });

    }


    /* AOYCO PTC */

    if(
      path===
      "/api/providers/aoyco/ptc" &&
      request.method==="GET"
    ){

      return aoycoPTC(
        request,
        env
      );

    }


    /* AOYCO POSTBACK */

    if(
      path===
      "/api/providers/aoyco/postback"
    ){

      const subId=
        clean(
          url.searchParams.get(
            "subId"
          )
        );

      const transId=
        clean(
          url.searchParams.get(
            "transId"
          )
        );

      const reward=
        Number(
          url.searchParams.get(
            "reward"
          ) || 0
        );

      const status=
        clean(
          url.searchParams.get(
            "status"
          ) || "1"
        );


      /*
       Aoyco postback needs
       its signature validation.
       The reward is accepted only
       after PROVIDER_SECRET is
       configured.
      */

      const secret=
        clean(
          env.AOYCO_SECRET ||
          env.PROVIDER_SECRET
        );


      if(!secret){

        return new Response(
          "missing-secret",
          {
            status:500
          }
        );

      }


      /*
       Aoyco signature:
       md5(subId + transId + reward + secret)

       Cloudflare Workers does not
       provide MD5 through WebCrypto,
       therefore this endpoint expects
       the provider secret to be configured
       and performs a basic protected
       endpoint check.

       For production Aoyco postback,
       configure the provider's signed
       callback according to the Aoyco
       dashboard.
      */


      const supplied=
        clean(
          url.searchParams.get(
            "signature"
          )
        );


      if(!supplied){

        return new Response(
          "invalid",
          {
            status:403
          }
        );

      }


      /*
       The actual Aoyco signature is
       intentionally not accepted blindly.
       This prevents unauthorized credits.
      */

      return new Response(
        "signature-validation-required",
        {
          status:501
        }
      );

    }


    /* OCTOCLICK POSTBACK */

    if(
      path===
      "/api/providers/octoclick/postback"
    ){

      let data={};


      if(
        request.method==="POST"
      ){

        const contentType=
          request.headers.get(
            "content-type"
          ) || "";


        if(
          contentType
          .includes("application/json")
        ){

          data=
            await request.json();

        }else{

          const text=
            await request.text();

          data=
            Object.fromEntries(
              new URLSearchParams(
                text
              )
            );

        }

      }else{

        data=
          Object.fromEntries(
            url.searchParams.entries()
          );

      }


      const subId=
        clean(
          data.subId ||
          data.sub_id ||
          data.user_id
        );


      const transId=
        clean(
          data.transId ||
          data.trans_id ||
          data.transaction_id
        );

const reward=
        Number(
          data.reward ||
          data.payout ||
          0
        );


      const secret=
        clean(
          env.OCTOCLICK_SECRET ||
          env.PROVIDER_SECRET
        );


      if(
        secret &&
        data.secret &&
        data.secret!==secret
      ){

        return new Response(
          "invalid",
          {
            status:403
          }
        );

      }


      if(
        !subId ||
        !transId ||
        !Number.isFinite(reward) ||
        reward<=0
      ){

        return new Response(
          "ok"
        );

      }


      const result=
        await providerCredit(
          env.DB,
          "octoclick",
          subId,
          transId,
          reward,
          data.status || "1"
        );


      return new Response(
        result.duplicate
          ? "ok"
          : "ok"
      );

    }


    return json(
      {
        ok:false,
        error:
          "Endpoint neexistuje."
      },
      404
    );


  }catch(error){

    console.error(error);

    return json(
      {
        ok:false,
        error:
          error?.message ||
          String(error)
      },
      500
    );

  }

}

};
