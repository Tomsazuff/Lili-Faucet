
const OWNER = "lili";

const MIN_WITHDRAWAL = 100;

const WEB_SHARE = 0.95;
const USER_SHARE = 0.05;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const ALLOWED_DAYS = [1, 5, 10, 20, 30];

const PROVIDERS = [
  "aoyco",
  "octoclick"
];


function now() {
  return new Date().toISOString();
}


function clean(v) {
  return String(v ?? "").trim();
}


function validUserId(v) {

  const id = clean(v).toLowerCase();

  if (!/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(id)) {
    throw new Error(
      "ID musí mať 3–64 znakov a môže obsahovať písmená, čísla, bodku, @, _ alebo -."
    );
  }

  return id;
}


function validEmail(v) {

  const email = clean(v).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Zadaj platný e-mail.");
  }

  return email;
}


function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
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


async function body(request) {

  const type =
    request.headers.get("content-type") || "";

  if (type.includes("application/json")) {
    return await request.json();
  }

  const form =
    await request.formData();

  return Object.fromEntries(
    form.entries()
  );

}


async function sha256(value) {

  const bytes =
    new TextEncoder().encode(
      String(value ?? "")
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
        x.toString(16).padStart(2, "0")
    )
    .join("");

}


function randomToken() {

  const bytes =
    new Uint8Array(32);

  crypto.getRandomValues(bytes);

  return [
    ...bytes
  ]
    .map(
      x =>
        x.toString(16).padStart(2, "0")
    )
    .join("");

}


/* =====================================================
   DATABASE
===================================================== */

async function schema(db) {

  await db.prepare(
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      bank_sats INTEGER NOT NULL DEFAULT 0,
      mining_sats INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      password_hash TEXT,
      is_registered INTEGER NOT NULL DEFAULT 0,
      email TEXT
    )
  ).run();


  try {

    await db.prepare(
      ALTER TABLE users
      ADD COLUMN password_hash TEXT
    ).run();

  } catch {}


  try {

    await db.prepare(
      ALTER TABLE users
      ADD COLUMN is_registered INTEGER NOT NULL DEFAULT 0
    ).run();

  } catch {}


  try {

    await db.prepare(
      ALTER TABLE users
      ADD COLUMN email TEXT
    ).run();

  } catch {}


  await db.prepare(
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS referrals(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      referrer_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS mining_cycles(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      principal_sats INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      rate REAL NOT NULL,
      earned_sats INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL
    )
  ).run();


  await db.prepare(`

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
  ).run();


  await db.prepare(
    CREATE TABLE IF NOT EXISTS provider_earnings(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider_ref TEXT NOT NULL UNIQUE,
      publisher_sats INTEGER NOT NULL,
      web_sats INTEGER NOT NULL,
      user_sats INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  ).run();


  await db.prepare(
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
  ).run();


  await ensureUser(
    db,
    OWNER
  );

}


/* =====================================================
   USERS
===================================================== */

async function getUser(db, id) {

  return await db
    .prepare(
      SELECT *
      FROM users
      WHERE id=?
    )
    .bind(id)
    .first();

}


async function ensureUser(db, id) {

  const uid =
    clean(id).toLowerCase();

  let user =
    await getUser(db, uid);


  if (!user) {

    await db
      .prepare(
        INSERT INTO users(
          id,
          bank_sats,
          mining_sats,
          created_at,
          is_registered
        )
        VALUES(?,0,0,?,0)
      )
      .bind(
        uid,
        now()
      )
      .run();


    user =
      await getUser(
        db,
        uid
      );

  }


  return user;

}


/* =====================================================
   SESSION
===================================================== */

async function createSession(
  db,
  userId
) {

  const raw =
    randomToken();

  const hashed =
    await sha256(raw);

  const expires =
    new Date(
      Date.now() +
      30 * 86400000
    ).toISOString();


  await db
    .prepare(
      INSERT INTO sessions(
        token_hash,
        user_id,
        expires_at,
        created_at
      )
      VALUES(?,?,?,?)
    )
    .bind(
      hashed,
      userId,
      expires,
      now()
    )
    .run();


  return raw;

}


async function auth(
  request,
  db
) {

  const header =
    request.headers.get(
      "Authorization"
    ) || "";


  if (
    !header.startsWith("Bearer ")
  ) {

    throw json(
      {
        ok: false,
        error: "Nie si prihlásený."
      },
      401
    );

  }


  const raw =
    header
      .slice(7)
      .trim();


  const hashed =
    await sha256(raw);


  const session =
    await db
      .prepare(
        SELECT *
        FROM sessions
        WHERE token_hash=?
        AND expires_at>?
      `)
      .bind(
        hashed,
        now()
      )
      .first();


  if (!session) {

    throw json(
      {
        ok: false,
        error:
          "Relácia skončila. Prihlás sa znova."
      },
      401
    );

  }


  return session.user_id;

}


/* =====================================================
   REGISTRATION
===================================================== */

async function register(
  db,
  userId,
  email,
  password,
  referrerId
) {

  const id =
    validUserId(userId);

  const em =
    validEmail(email);

  const pass =
    String(password ?? "");


  if (pass.length < 6) {

    throw new Error(
      "Heslo musí mať aspoň 6 znakov."
    );

  }


  if (id === OWNER) {

    throw new Error(
      "Toto ID je vyhradené."
    );

  }


  const existingId =
    await getUser(
      db,
      id
    );


  if (
    existingId &&
    Number(
      existingId.is_registered || 0
    ) === 1
  ) {

    throw new Error(
      "Používateľské ID už existuje."
    );

  }

const existingEmail =
    await db
      .prepare(
        SELECT id
        FROM users
        WHERE lower(email)=?
        AND is_registered=1
      )
      .bind(em)
      .first();


  if (
    existingEmail &&
    existingEmail.id !== id
  ) {

    throw new Error(
      "Tento e-mail už existuje."
    );

  }


  const passwordHash =
    await sha256(pass);


  await db
    .prepare(
      UPDATE users
      SET
        password_hash=?,
        email=?,
        is_registered=1
      WHERE id=?
    )
    .bind(
      passwordHash,
      em,
      id
    )
    .run();


  const ref =
    clean(referrerId)
      .toLowerCase();


  if (
    ref &&
    ref !== id
  ) {

    const refUser =
      await getUser(
        db,
        ref
      );


    if (
      refUser &&
      Number(
        refUser.is_registered || 0
      ) === 1
    ) {

      const already =
        await db
          .prepare(
            SELECT id
            FROM referrals
            WHERE user_id=?
          )
          .bind(id)
          .first();


      if (!already) {

        await db
          .prepare(
            INSERT INTO referrals(
              user_id,
              referrer_id,
              created_at
            )
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

  }


  return {
    user_id: id,
    token:
      await createSession(
        db,
        id
      )
  };

}


/* =====================================================
   LOGIN
===================================================== */

async function login(
  db,
  loginValue,
  password
) {

  const login =
    clean(loginValue)
      .toLowerCase();


  if (!login) {

    throw new Error(
      "Zadaj e-mail alebo používateľské ID."
    );

  }


  const hash =
    await sha256(password);


  const user =
    await db
      .prepare(
        SELECT *
        FROM users
        WHERE lower(id)=?
        OR lower(email)=?
        LIMIT 1
      )
      .bind(
        login,
        login
      )
      .first();


  if (
    !user ||
    Number(
      user.is_registered || 0
    ) !== 1
  ) {

    throw new Error(
      "Účet neexistuje."
    );

  }


  if (
    user.password_hash !== hash
  ) {

    throw new Error(
      "Nesprávne heslo."
    );

  }


  return {
    user_id: user.id,
    token:
      await createSession(
        db,
        user.id
      )
  };

}


/* =====================================================
   MINING
===================================================== */

async function accrueMining(
  db,
  userId
) {

  const result =
    await db
      .prepare(
        SELECT *
        FROM mining_cycles
        WHERE user_id=?
        AND status='active'
      )
      .bind(userId)
      .all();


  for (
    const cycle of
    result.results || []
  ) {

    const start =
      new Date(
        cycle.started_at
      ).getTime();


    const end =
      new Date(
        cycle.ends_at
      ).getTime();


    const t =
      Math.min(
        Date.now(),
        end
      );


    const progress =
      Math.min(
        1,
        Math.max(
          0,
          (t - start) /
          (end - start)
        )
      );


    const earned =
      Math.floor(
        Number(
          cycle.principal_sats
        ) *
        Number(
          cycle.rate
        ) *
        progress
      );


    if (
      earned !==
      Number(
        cycle.earned_sats || 0
      )
    ) {

      await db
        .prepare(
          UPDATE mining_cycles
          SET earned_sats=?
          WHERE id=?
        )
        .bind(
          earned,
          cycle.id
        )
        .run();

    }

  }

}


async function releaseFinished(db) {

  const result =
    await db
      .prepare(
        SELECT *
        FROM mining_cycles
        WHERE status='active'
        AND ends_at<=?
      )
      .bind(now())
      .all();


  for (
    const cycle of
    result.results || []
  ) {

const earned =
      Math.floor(
        Number(
          cycle.principal_sats
        ) *
        Number(
          cycle.rate
        )
      );


    const total =
      Number(
        cycle.principal_sats
      ) +
      earned;


    await db.batch([

      db
        .prepare(
          UPDATE mining_cycles
          SET
            earned_sats=?,
            status='completed'
          WHERE id=?
        )
        .bind(
          earned,
          cycle.id
        ),

      db
        .prepare(
          UPDATE users
          SET bank_sats=bank_sats+?
          WHERE id=?
        )
        .bind(
          total,
          cycle.user_id
        ),

      db
        .prepare(
          INSERT INTO transactions(
            user_id,
            type,
            amount_sats,
            bank_change_sats,
            mining_change_sats,
            reference,
            created_at
          )
          VALUES(?,?,?,?,?,?,?)
        )
        .bind(
          cycle.user_id,
          "MINING_RELEASE",
          total,
          total,
          0,
          "cycle:" + cycle.id,
          now()
        )

    ]);

  }

}


async function state(
  db,
  userId
) {

  await ensureUser(
    db,
    userId
  );

  await accrueMining(
    db,
    userId
  );

  await releaseFinished(
    db
  );


  const user =
    await getUser(
      db,
      userId
    );


  const cycles =
    await db
      .prepare(
        SELECT *
        FROM mining_cycles
        WHERE user_id=?
        ORDER BY id DESC
      )
      .bind(userId)
      .all();


  return {

    user_id:
      user.id,

    bank_sats:
      Number(
        user.bank_sats || 0
      ),

    mining_sats:
      Number(
        user.mining_sats || 0
      ),

    cycles:
      cycles.results || []

  };

}


/* =====================================================
   BANK → MINING
===================================================== */

async function moveBankToMining(
  db,
  userId,
  amount
) {

  amount =
    Math.floor(
      Number(amount)
    );


  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {

    throw new Error(
      "Neplatná suma."
    );

  }


  const user =
    await getUser(
      db,
      userId
    );


  if (
    Number(
      user.bank_sats || 0
    ) < amount
  ) {

    throw new Error(
      "V Banku nemáš dostatok sat."
    );

  }


  await db.batch([

    db
      .prepare(
        UPDATE users
        SET
          bank_sats=bank_sats-?,
          mining_sats=mining_sats+?
        WHERE id=?
      )
      .bind(
        amount,
        amount,
        userId
      ),

    db
      .prepare(
        INSERT INTO transactions(
          user_id,
          type,
          amount_sats,
          bank_change_sats,
          mining_change_sats,
          reference,
          created_at
        )
        VALUES(?,?,?,?,?,?,?)
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
    amount_sats: amount
  };

}


/* =====================================================
   START MINING
===================================================== */

async function startMining(
  db,
  userId,
  days
) {

  days =
    Number(days);


  if (
    !ALLOWED_DAYS.includes(days)
  ) {

    throw new Error(
      "Povolené obdobia: 1, 5, 10, 20 alebo 30 dní."
    );

  }


  await accrueMining(
    db,
    userId
  );

  await releaseFinished(
    db
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


  if (amount <= 0) {

    throw new Error(
      "V Mining nemáš žiadne sat."
    );

  }


  const start =
    new Date();


  const end =
    new Date(
      start.getTime() +
      days * 86400000
    );


  const rate =
    MINING_RATES[days];

const result =
    await db
      .prepare(
        INSERT INTO mining_cycles(
          user_id,
          principal_sats,
          duration_days,
          rate,
          earned_sats,
          started_at,
          ends_at,
          status
        )
        VALUES(?,?,?,?,0,?,?,?)
      )
      .bind(
        userId,
        amount,
        days,
        rate,
        start.toISOString(),
        end.toISOString(),
        "active"
      )
      .run();


  const cycleId =
    result.meta.last_row_id;


  await db.batch([

    db
      .prepare(
        UPDATE users
        SET mining_sats=0
        WHERE id=?
      )
      .bind(userId),

    db
      .prepare(
        INSERT INTO transactions(
          user_id,
          type,
          amount_sats,
          bank_change_sats,
          mining_change_sats,
          reference,
          created_at
        )
        VALUES(?,?,?,?,?,?,?)
      )
      .bind(
        userId,
        "MINING_START",
        amount,
        0,
        -amount,
        "cycle:" + cycleId,
        now()
      )

  ]);


  return {

    cycle_id:
      cycleId,

    principal_sats:
      amount,

    duration_days:
      days,

    rate:
      rate,

    ends_at:
      end.toISOString()

  };

}


/* =====================================================
   PROVIDERS
===================================================== */

async function providerPostback(
  db,
  provider,
  data
) {

  provider =
    clean(provider)
      .toLowerCase();


  if (
    !PROVIDERS.includes(provider)
  ) {

    throw new Error(
      "Provider musí byť Aoyco alebo OctoClick."
    );

  }


  const userId =
    clean(data.user_id)
      .toLowerCase();


  const providerRef =
    clean(
      data.provider_ref
    );


  const publisherSats =
    Math.floor(
      Number(
        data.publisher_sats
      )
    );


  if (
    !userId ||
    !providerRef ||
    !Number.isFinite(
      publisherSats
    ) ||
    publisherSats <= 0
  ) {

    throw new Error(
      "Neplatný provider postback."
    );

  }


  const duplicate =
    await db
      .prepare(
        SELECT id
        FROM provider_earnings
        WHERE provider_ref=?
      )
      .bind(providerRef)
      .first();


  if (duplicate) {

    return {
      duplicate: true
    };

  }


  const user =
    await getUser(
      db,
      userId
    );


  if (
    !user ||
    Number(
      user.is_registered || 0
    ) !== 1
  ) {

    throw new Error(
      "Používateľ pre provider neexistuje."
    );

  }


  const webSats =
    Math.floor(
      publisherSats *
      WEB_SHARE
    );


  const userSats =
    publisherSats -
    webSats;


  await db.batch([

    db
      .prepare(
        INSERT INTO provider_earnings(
          provider,
          user_id,
          provider_ref,
          publisher_sats,
          web_sats,
          user_sats,
          status,
          created_at
        )
        VALUES(?,?,?,?,?,?,?,?)
      )
      .bind(
        provider,
        userId,
        providerRef,
        publisherSats,
        webSats,
        userSats,
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
        webSats,
        OWNER
      ),

    db
      .prepare(
        INSERT INTO transactions(
          user_id,
          type,
          amount_sats,
          bank_change_sats,
          mining_change_sats,
          reference,
          created_at
        )
        VALUES(?,?,?,?,?,?,?)
      )
      .bind(
        OWNER,
        "PROVIDER_WEB",
        webSats,
        webSats,
        0,
        provider + ":" + providerRef,
        now()
      )

  ]);


  if (userSats > 0) {

    await db.batch([

      db
        .prepare(
          UPDATE users
          SET bank_sats=bank_sats+?
          WHERE id=?
        )
        .bind(
          userSats,
          userId
        ),

db
        .prepare(
          INSERT INTO transactions(
            user_id,
            type,
            amount_sats,
            bank_change_sats,
            mining_change_sats,
            reference,
            created_at
          )
          VALUES(?,?,?,?,?,?,?)
        )
        .bind(
          userId,
          "PROVIDER_REWARD",
          userSats,
          userSats,
          0,
          provider + ":" + providerRef,
          now()
        )

    ]);

  }


  return {

    duplicate: false,

    provider:

      provider,

    publisher_sats:

      publisherSats,

    web_sats:

      webSats,

    user_sats:

      userSats

  };

}


/* =====================================================
   WITHDRAW
===================================================== */

async function withdraw(
  db,
  userId,
  amount,
  method,
  address
) {

  amount =
    Math.floor(
      Number(amount)
    );


  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAWAL
  ) {

    throw new Error(
      "Minimum výberu je 100 sat."
    );

  }


  address =
    clean(address);


  if (!address) {

    throw new Error(
      "Zadaj BTC adresu alebo FaucetPay cieľ."
    );

  }


  const user =
    await getUser(
      db,
      userId
    );


  if (
    Number(
      user.bank_sats || 0
    ) < amount
  ) {

    throw new Error(
      "V Banku nemáš dostatok sat."
    );

  }


  const result =
    await db
      .prepare(
        INSERT INTO withdrawals(
          user_id,
          amount_sats,
          method,
          address,
          status,
          created_at
        )
        VALUES(?,?,?,?,?,?)
      )
      .bind(
        userId,
        amount,
        clean(method) || "BTC",
        address,
        "pending",
        now()
      )
      .run();


  const id =
    result.meta.last_row_id;


  await db.batch([

    db
      .prepare(
        UPDATE users
        SET bank_sats=bank_sats-?
        WHERE id=?
      )
      .bind(
        amount,
        userId
      ),

    db
      .prepare(
        INSERT INTO transactions(
          user_id,
          type,
          amount_sats,
          bank_change_sats,
          mining_change_sats,
          reference,
          created_at
        )
        VALUES(?,?,?,?,?,?,?)
      )
      .bind(
        userId,
        "WITHDRAWAL_PENDING",
        amount,
        -amount,
        0,
        "withdrawal:" + id,
        now()
      )

  ]);


  return {

    withdrawal_id:
      id,

    amount_sats:
      amount,

    status:
      "pending"

  };

}


/* =====================================================
   HISTORY
===================================================== */

async function transactions(
  db,
  userId
) {

  const result =
    await db
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
      .bind(userId)
      .all();


  return {

    transactions:
      result.results || []

  };

}


/* =====================================================
   ROUTER
===================================================== */

async function route(
  request,
  env
) {

  if (!env.DB) {

    return json(
      {
        ok: false,
        error:
          "Cloudflare D1 binding DB nie je nastavený."
      },
      500
    );

  }


  const db =
    env.DB;


  await schema(db);


  const url =
    new URL(
      request.url
    );


  const path =
    url.pathname;


  const method =
    request.method.toUpperCase();


  if (
    method === "OPTIONS"
  ) {

    return json({
      ok: true
    });

  }


  if (
    method === "GET" &&
    path === "/"
  ) {

    return json({
      ok: true,
      status: "online",
      service: "Lili Faucet"
    });

  }


  /* REGISTER */

  if (
    method === "POST" &&
    path === "/api/register"
  ) {

    try {

      const b =
        await body(request);

return json({
        ok: true,
        ...await register(
          db,
          b.user_id,
          b.email,
          b.password,
          b.referrer_id
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        400
      );

    }

  }


  /* LOGIN */

  if (
    method === "POST" &&
    path === "/api/login"
  ) {

    try {

      const b =
        await body(request);


      return json({
        ok: true,
        ...await login(
          db,
          b.login,
          b.password
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        401
      );

    }

  }


  /* PROVIDER */

  if (
    method === "POST" &&
    path.startsWith(
      "/api/provider/"
    )
  ) {

    const secret =
      clean(
        env.PROVIDER_SECRET
      );


    const supplied =
      clean(
        request.headers.get(
          "X-Provider-Key"
        )
      );


    if (
      !secret ||
      supplied !== secret
    ) {

      return json(
        {
          ok: false,
          error:
            "Neplatný provider key."
        },
        401
      );

    }


    try {

      const provider =
        path.substring(
          "/api/provider/".length
        );


      const b =
        await body(request);


      return json({
        ok: true,
        ...await providerPostback(
          db,
          provider,
          b
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        400
      );

    }

  }


  /* AUTH */

  let userId;


  try {

    userId =
      await auth(
        request,
        db
      );

  } catch (e) {

    return e;

  }


  /* STATE */

  if (
    method === "GET" &&
    path === "/api/state"
  ) {

    try {

      return json({
        ok: true,
        ...await state(
          db,
          userId
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        500
      );

    }

  }


  /* REFERRALS */

  if (
    method === "GET" &&
    path === "/api/referrals"
  ) {

    const result =
      await db
        .prepare(
          SELECT COUNT(*) AS count
          FROM referrals
          WHERE referrer_id=?
        )
        .bind(userId)
        .first();


    return json({
      ok: true,
      count:
        Number(
          result?.count || 0
        )
    });

  }


  /* BANK → MINING */

  if (
    method === "POST" &&
    path === "/api/bank/to-mining"
  ) {

    try {

      const b =
        await body(request);


      return json({
        ok: true,
        ...await moveBankToMining(
          db,
          userId,
          b.amount_sats
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        400
      );

    }

  }


  /* START MINING */

  if (
    method === "POST" &&
    path === "/api/mining/start"
  ) {

    try {

      const b =
        await body(request);


      return json({
        ok: true,
        ...await startMining(
          db,
          userId,
          b.duration_days
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        400
      );

    }

  }


  /* WITHDRAW */

  if (
    method === "POST" &&
    path === "/api/withdraw"
  ) {

    try {

      const b =
        await body(request);


      return json({
        ok: true,
        ...await withdraw(
          db,
          userId,
          b.amount_sats,
          b.method,
          b.address
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        400
      );

    }

  }


  /* HISTORY */

  if (
    method === "GET" &&
    path === "/api/transactions"
  ) {

    try {

return json({
        ok: true,
        ...await transactions(
          db,
          userId
        )
      });

    } catch (e) {

      return json(
        {
          ok: false,
          error: e.message
        },
        500
      );

    }

  }


  return json(
    {
      ok: false,
      error:
        "Endpoint neexistuje."
    },
    404
  );

}


/* =====================================================
   CLOUDFLARE
===================================================== */

export default {

  async fetch(
    request,
    env
  ) {

    try {

      return await route(
        request,
        env
      );

    } catch (e) {

      console.error(e);

      return json(
        {
          ok: false,
          error:
            e.message ||
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
  ) {

    if (!env.DB) {
      return;
    }


    ctx.waitUntil(

      (async () => {

        await schema(
          env.DB
        );


        const active =
          await env.DB
            .prepare(
              SELECT user_id
              FROM mining_cycles
              WHERE status='active'
              AND ends_at<=?
            )
            .bind(now())
            .all();


        for (
          const row of
          active.results || []
        ) {

          await accrueMining(
            env.DB,
            row.user_id
          );

        }


        await releaseFinished(
          env.DB
        );

      })()

    );

  }

};
