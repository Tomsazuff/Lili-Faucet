
const OWNER = "lili";
const MIN_WITHDRAW = 100;

const MINING_RATES = {
  1: 0.0067,
  5: 0.0333,
  10: 0.08,
  20: 0.1667,
  30: 0.2667
};

const PROVIDERS = {
  aoyco: { name: "Aoyco", bankShare: 0.95, referralShare: 0.05 },
  octoclick: { name: "OctoClick", bankShare: 0.95, referralShare: 0.05 }
};

function response(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Provider-Secret"
    }
  });
}

async function body(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

function timestamp() {
  return Date.now();
}

function makeToken() {
  return crypto.randomUUID() + "-" + crypto.randomUUID();
}

async function passwordHash(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(hash))
    .map(function (x) {
      return x.toString(16).padStart(2, "0");
    })
    .join("");
}

function miningRate(days) {
  return MINING_RATES[Number(days)] || 0;
}


/* DATABASE */

async function setup(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, bank_sats INTEGER DEFAULT 0, mining_sats INTEGER DEFAULT 0, is_registered INTEGER DEFAULT 0, created_at INTEGER)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id TEXT NOT NULL, referred_id TEXT NOT NULL UNIQUE, created_at INTEGER)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS mining_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, principal_sats INTEGER NOT NULL, duration_days INTEGER NOT NULL, rate REAL NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, released INTEGER DEFAULT 0, created_at INTEGER)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL, amount_sats INTEGER NOT NULL, description TEXT, created_at INTEGER)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS provider_earnings (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, user_id TEXT, gross_sats INTEGER NOT NULL, bank_sats INTEGER NOT NULL, referral_sats INTEGER NOT NULL, created_at INTEGER)"
  ).run();

  await db.prepare(
    "CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, amount_sats INTEGER NOT NULL, method TEXT, address TEXT, status TEXT DEFAULT 'pending', created_at INTEGER)"
  ).run();

  await db.prepare(
    "INSERT OR IGNORE INTO users (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(
    OWNER,
    "",
    "",
    0,
    0,
    1,
    timestamp()
  ).run();
}


async function getUser(db, id) {
  return await db.prepare(
    "SELECT * FROM users WHERE id=?"
  ).bind(id).first();
}


async function createSession(db, userId) {
  const value = makeToken();

  await db.prepare(
    "INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(
    value,
    userId,
    timestamp(),
    timestamp() + 2592000000
  ).run();

  return value;
}


async function authenticated(request, db) {
  const header =
    request.headers.get("Authorization") || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const value =
    header.slice(7).trim();

  if (!value) {
    return null;
  }

  return await db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?"
  ).bind(
    value,
    timestamp()
  ).first();
}

/* MINING - UKONCENE CYKLY */

async function releaseMining(db) {
  const rows = await db.prepare(
    "SELECT * FROM mining_cycles WHERE released=0 AND end_at<=?"
  ).bind(timestamp()).all();

  for (const cycle of rows.results || []) {
    const principal =
      Number(cycle.principal_sats);

    const profit =
      Math.floor(
        principal * Number(cycle.rate)
      );

    const total =
      principal + profit;

    const userUpdate =
      await db.prepare(
        "UPDATE users SET bank_sats=bank_sats+? WHERE id=?"
      ).bind(
        total,
        cycle.user_id
      ).run();

    if (
      Number(
        userUpdate.meta &&
        userUpdate.meta.changes || 0
      ) !== 1
    ) {
      continue;
    }

    const cycleUpdate =
      await db.prepare(
        "UPDATE mining_cycles SET released=1 WHERE id=? AND released=0"
      ).bind(
        cycle.id
      ).run();

    if (
      Number(
        cycleUpdate.meta &&
        cycleUpdate.meta.changes || 0
      ) !== 1
    ) {
      continue;
    }

    await db.prepare(
      "INSERT INTO transactions (user_id,type,amount_sats,description,created_at) VALUES (?,?,?,?,?)"
    ).bind(
      cycle.user_id,
      "mining_release",
      total,
      "Mining " +
        cycle.duration_days +
        " dni: vklad " +
        principal +
        " sat + zisk " +
        profit +
        " sat",
      timestamp()
    ).run();
  }
}


/* REGISTRACIA */

async function register(db, data) {
  const id =
    String(data.user_id || "")
      .trim()
      .toLowerCase();

  const email =
    String(data.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(data.password || "");

  const referrer =
    String(data.referrer_id || "")
      .trim()
      .toLowerCase();

  if (!id || id.length < 3) {
    return response({
      error:
        "Pouzivatelske meno musi mat aspon 3 znaky."
    }, 400);
  }

  if (!email || !email.includes("@")) {
    return response({
      error:
        "Zadaj platny email."
    }, 400);
  }

  if (password.length < 6) {
    return response({
      error:
        "Heslo musi mat aspon 6 znakov."
    }, 400);
  }

  if (id === OWNER) {
    return response({
      error:
        "Toto pouzivatelske meno je rezervovane."
    }, 400);
  }

  const old =
    await getUser(db, id);

  if (
    old &&
    Number(old.is_registered) === 1
  ) {
    return response({
      error:
        "Pouzivatel uz existuje."
    }, 409);
  }

  const hash =
    await passwordHash(password);

  if (old) {
    await db.prepare(
      "UPDATE users SET email=?,password_hash=?,is_registered=1 WHERE id=?"
    ).bind(
      email,
      hash,
      id
    ).run();
  } else {
    await db.prepare(
      "INSERT INTO users (id,email,password_hash,bank_sats,mining_sats,is_registered,created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(
      id,
      email,
      hash,
      0,
      0,
      1,
      timestamp()
    ).run();
  }

  if (
    referrer &&
    referrer !== id
  ) {
    const refUser =
      await getUser(db, referrer);

    if (
      refUser &&
      (
        Number(refUser.is_registered) === 1 ||
        referrer === OWNER
      )
    ) {
      await db.prepare(
        "INSERT OR IGNORE INTO referrals (referrer_id,referred_id,created_at) VALUES (?,?,?)"
      ).bind(
        referrer,
        id,
        timestamp()
      ).run();
    }
  }

  return response({
    ok: true,
    user_id: id,
    token:
      await createSession(db, id)
  });
}


/* LOGIN */

async function login(db, data) {
  const loginValue =
    String(data.login || "")
      .trim()
      .toLowerCase();

  const password =
    String(data.password || "");

  if (!loginValue || !password) {
    return response({
      error:
        "Vypln prihlasovacie udaje."
    }, 400);
  }

  const user =
    await db.prepare(
      "SELECT * FROM users WHERE id=? OR email=? LIMIT 1"
    ).bind(
      loginValue,
      loginValue
    ).first();

if (
    !user ||
    Number(user.is_registered) !== 1
  ) {
    return response({
      error:
        "Nespravne prihlasovacie udaje."
    }, 401);
  }

  const hash =
    await passwordHash(password);

  if (hash !== user.password_hash) {
    return response({
      error:
        "Nespravne prihlasovacie udaje."
    }, 401);
  }

  return response({
    ok: true,
    user_id: user.id,
    token:
      await createSession(db, user.id)
  });
}


/* STAV */

async function state(db, user) {
  const rows =
    await db.prepare(
      "SELECT * FROM mining_cycles WHERE user_id=? AND released=0 ORDER BY id DESC"
    ).bind(user.id).all();

  const mining =
    (rows.results || []).map(
      function (cycle) {
        const principal =
          Number(cycle.principal_sats);

        const profit =
          Math.floor(
            principal *
            Number(cycle.rate)
          );

        const start =
          Number(cycle.start_at);

        const end =
          Number(cycle.end_at);

        const progress =
          Math.min(
            1,
            Math.max(
              0,
              (
                timestamp() - start
              ) /
              Math.max(
                1,
                end - start
              )
            )
          );

        return {
          id: cycle.id,
          principal_sats: principal,
          duration_days:
            Number(cycle.duration_days),
          rate:
            Number(cycle.rate),
          profit_sats: profit,
          final_sats:
            principal + profit,
          progress: progress,
          end_at: end
        };
      }
    );

  return response({
    ok: true,

    user: {
      id: user.id,
      email: user.email,
      bank_sats:
        Number(user.bank_sats || 0),
      mining_sats:
        Number(user.mining_sats || 0)
    },

    mining: mining,

    mining_rates:
      MINING_RATES,

    min_withdraw:
      MIN_WITHDRAW
  });
}


/* BANK -> MINING */

async function bankToMining(db, user, data) {
  const amount =
    Math.floor(
      Number(data.amount_sats)
    );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return response({
      error:
        "Neplatna suma."
    }, 400);
  }

  const result =
    await db.prepare(
      "UPDATE users SET bank_sats=bank_sats-?,mining_sats=mining_sats+? WHERE id=? AND bank_sats>=?"
    ).bind(
      amount,
      amount,
      user.id,
      amount
    ).run();

  if (
    Number(
      result.meta &&
      result.meta.changes || 0
    ) !== 1
  ) {
    return response({
      error:
        "Na Banku nemas dostatok satoshi."
    }, 400);
  }

  await db.prepare(
    "INSERT INTO transactions (user_id,type,amount_sats,description,created_at) VALUES (?,?,?,?,?)"
  ).bind(
    user.id,
    "bank_to_mining",
    amount,
    "Presun z Banku do Mining",
    timestamp()
  ).run();

  return response({
    ok: true,
    amount_sats: amount
  });
}


/* SPUSTENIE MININGU */

async function startMining(db, user, data) {
  const days =
    Number(data.duration_days);

  const rate =
    miningRate(days);

  if (!rate) {
    return response({
      error:
        "Povolene trvanie je 1, 5, 10, 20 alebo 30 dni."
    }, 400);
  }

  const current =
    await getUser(db, user.id);

  const amount =
    Number(
      current.mining_sats || 0
    );

  if (amount <= 0) {
    return response({
      error:
        "V Mining nemas ziadne satoshi."
    }, 400);
  }

  const start =
    timestamp();

  const end =
    start +
    days *
    86400000;

  const profit =
    Math.floor(
      amount * rate
    );

  const total =
    amount + profit;

  const update =
    await db.prepare(
      "UPDATE users SET mining_sats=0 WHERE id=? AND mining_sats=?"
    ).bind(
      user.id,
      amount
    ).run();

  if (
    Number(
      update.meta &&
      update.meta.changes || 0
    ) !== 1
  ) {
    return response({
      error:
        "Spustenie miningu sa nepodarilo."
    }, 409);
  }

await db.prepare(
    "INSERT INTO mining_cycles (user_id,principal_sats,duration_days,rate,start_at,end_at,released,created_at) VALUES (?,?,?,?,?,?,0,?)"
  ).bind(
    user.id,
    amount,
    days,
    rate,
    start,
    end,
    timestamp()
  ).run();

  await db.prepare(
    "INSERT INTO transactions (user_id,type,amount_sats,description,created_at) VALUES (?,?,?,?,?)"
  ).bind(
    user.id,
    "mining_start",
    amount,
    "Spusteny mining na " +
      days +
      " dni. Vklad " +
      amount +
      " sat, ocakavany zisk " +
      profit +
      " sat, spolu " +
      total +
      " sat.",
    timestamp()
  ).run();

  return response({
    ok: true,
    principal_sats: amount,
    profit_sats: profit,
    final_sats: total,
    duration_days: days,
    rate: rate
  });
}


/* REFERRALS */

async function referrals(db, user) {
  const rows =
    await db.prepare(
      "SELECT referred_id,created_at FROM referrals WHERE referrer_id=? ORDER BY id DESC"
    ).bind(user.id).all();

  return response({
    ok: true,
    referral_id: user.id,
    count:
      (rows.results || []).length,
    referrals:
      rows.results || []
  });
}


/* HISTORIA */

async function transactions(db, user) {
  const rows =
    await db.prepare(
      "SELECT id,type,amount_sats,description,created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 200"
    ).bind(user.id).all();

  return response({
    ok: true,
    transactions:
      rows.results || []
  });
}


/* VYBER */

async function withdraw(db, user, data) {
  const amount =
    Math.floor(
      Number(data.amount_sats)
    );

  const method =
    String(
      data.method || "FaucetPay"
    ).trim();

  const address =
    String(
      data.address || ""
    ).trim();

  if (
    !Number.isFinite(amount) ||
    amount < MIN_WITHDRAW
  ) {
    return response({
      error:
        "Minimum vyber je " +
        MIN_WITHDRAW +
        " sat."
    }, 400);
  }

  if (!address) {
    return response({
      error:
        "Zadaj adresu alebo ucet pre vyplatu."
    }, 400);
  }

  const update =
    await db.prepare(
      "UPDATE users SET bank_sats=bank_sats-? WHERE id=? AND bank_sats>=?"
    ).bind(
      amount,
      user.id,
      amount
    ).run();

  if (
    Number(
      update.meta &&
      update.meta.changes || 0
    ) !== 1
  ) {
    return response({
      error:
        "Na Banku nemas dostatok satoshi."
    }, 400);
  }

  await db.prepare(
    "INSERT INTO withdrawals (user_id,amount_sats,method,address,status,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(
    user.id,
    amount,
    method,
    address,
    "pending",
    timestamp()
  ).run();

  await db.prepare(
    "INSERT INTO transactions (user_id,type,amount_sats,description,created_at) VALUES (?,?,?,?,?)"
  ).bind(
    user.id,
    "withdrawal",
    amount,
    "Vyber " +
      method +
      " - caka na spracovanie",
    timestamp()
  ).run();

  return response({
    ok: true,
    status: "pending",
    message:
      "Vyber bol prijaty a caka na spracovanie."
  });
}


/* PROVIDER POSTBACK */

async function providerPostback(
  db,
  env,
  providerKey,
  data
) {
  const secret =
    env.PROVIDER_SECRET;

  if (!secret) {
    return response({
      error:
        "PROVIDER_SECRET nie je nastaveny."
    }, 500);
  }

  if (
    String(data.secret || "") !==
    String(secret)
  ) {
    return response({
      error:
        "Neplatny provider secret."
    }, 401);
  }

  const provider =
    PROVIDERS[providerKey];

  const gross =
    Math.floor(
      Number(data.amount_sats)
    );

  const userId =
    String(
      data.user_id || ""
    )
      .trim()
      .toLowerCase();

  if (
    !provider ||
    !userId ||
    !Number.isFinite(gross) ||
    gross <= 0
  ) {
    return response({
      error:
        "Neplatne udaje postbacku."
    }, 400);
  }

  const user =
    await getUser(
      db,
      userId
    );

  if (
    !user ||
    Number(user.is_registered) !== 1
  ) {
    return response({
      error:
        "Pouzivatel neexistuje."
    }, 404);
  }

const bank =
    Math.floor(
      gross *
      provider.bankShare
    );

  const referralPart =
    gross - bank;

  const update =
    await db.prepare(
      "UPDATE users SET bank_sats=bank_sats+? WHERE id=?"
    ).bind(
      bank,
      userId
    ).run();

  if (
    Number(
      update.meta &&
      update.meta.changes || 0
    ) !== 1
  ) {
    return response({
      error:
        "Pripisanie odmeny zlyhalo."
    }, 409);
  }

  const ref =
    await db.prepare(
      "SELECT referrer_id FROM referrals WHERE referred_id=?"
    ).bind(
      userId
    ).first();

  let referralPaid = 0;

  if (
    ref &&
    ref.referrer_id
  ) {
    const refUpdate =
      await db.prepare(
        "UPDATE users SET bank_sats=bank_sats+? WHERE id=?"
      ).bind(
        referralPart,
        ref.referrer_id
      ).run();

    if (
      Number(
        refUpdate.meta &&
        refUpdate.meta.changes || 0
      ) === 1
    ) {
      referralPaid =
        referralPart;
    }
  }

  await db.prepare(
    "INSERT INTO provider_earnings (provider,user_id,gross_sats,bank_sats,referral_sats,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(
    providerKey,
    userId,
    gross,
    bank,
    referralPaid,
    timestamp()
  ).run();

  await db.prepare(
    "INSERT INTO transactions (user_id,type,amount_sats,description,created_at) VALUES (?,?,?,?,?)"
  ).bind(
    userId,
    "provider",
    bank,
    provider.name +
      " odmena - 95 % do Banku",
    timestamp()
  ).run();

  if (referralPaid > 0) {
    await db.prepare(
      "INSERT INTO transactions (user_id,type,amount_sats,description,created_at) VALUES (?,?,?,?,?)"
    ).bind(
      ref.referrer_id,
      "referral",
      referralPaid,
      "Referral od " +
        provider.name +
        " - 5 %",
      timestamp()
    ).run();
  }

  return response({
    ok: true,
    provider:
      provider.name,
    gross_sats:
      gross,
    bank_sats:
      bank,
    referral_sats:
      referralPaid
  });
}


/* WORKER */

export default {
  async fetch(request, env) {

    if (
      request.method === "OPTIONS"
    ) {
      return response({
        ok: true
      });
    }

    try {
      const db =
        env.DB;

      if (!db) {
        return response({
          error:
            "D1 binding DB nie je nastaveny."
        }, 500);
      }

      await setup(db);
      await releaseMining(db);

      const url =
        new URL(request.url);

      const path =
        url.pathname;

      const data =
        await body(request);

      if (
        request.method === "GET" &&
        path === "/"
      ) {
        return response({
          ok: true,
          name: "Lili Faucet",
          status: "online"
        });
      }

      if (
        request.method === "POST" &&
        path === "/api/register"
      ) {
        return await register(
          db,
          data
        );
      }

      if (
        request.method === "POST" &&
        path === "/api/login"
      ) {
        return await login(
          db,
          data
        );
      }

      if (
        request.method === "POST" &&
        path === "/api/provider/aoyco"
      ) {
        return await providerPostback(
          db,
          env,
          "aoyco",
          data
        );
      }

      if (
        request.method === "POST" &&
        path === "/api/provider/octoclick"
      ) {
        return await providerPostback(
          db,
          env,
          "octoclick",
          data
        );
      }

      const user =
        await authenticated(
          request,
          db
        );

      if (!user) {
        return response({
          error:
            "Nie si prihlaseny."
        }, 401);
      }

      if (
        request.method === "GET" &&
        path === "/api/state"
      ) {
        return await state(
          db,
          user
        );
      }

      if (
        request.method === "POST" &&
        path === "/api/bank/to-mining"
      ) {
        return await bankToMining(
          db,
          user,
          data
        );
      }

if (
        request.method === "POST" &&
        path === "/api/mining/start"
      ) {
        return await startMining(
          db,
          user,
          data
        );
      }

      if (
        request.method === "GET" &&
        path === "/api/referrals"
      ) {
        return await referrals(
          db,
          user
        );
      }

      if (
        request.method === "GET" &&
        path === "/api/transactions"
      ) {
        return await transactions(
          db,
          user
        );
      }

      if (
        request.method === "POST" &&
        path === "/api/withdraw"
      ) {
        return await withdraw(
          db,
          user,
          data
        );
      }

      return response({
        error:
          "Endpoint neexistuje."
      }, 404);

    } catch (error) {

      return response({
        error:
          "Serverova chyba.",
        detail:
          String(
            error &&
            error.message ||
            error
          )
      }, 500);
    }
  }
};
