require("dotenv").config();

const AUTH_KEY = process.env.AUTH_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;

const awsDetails = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_KEY: process.env.AWS_SECRET_KEY,
  AWS_BUCKET_NAME: process.env.AWS_BUCKET_NAME,
  AWS_BACKUP_FOLDER: process.env.AWS_BACKUP_FOLDER,
  AWS_REGION: process.env.AWS_REGION,
}

const REQUEST_PASSTHROUGH_HOST = process.env.REQUEST_PASSTHROUGH_HOST;
const REQUEST_PASSTHROUGH_PORT = process.env.REQUEST_PASSTHROUGH_PORT;

const GENERIC_FAILURE_RESPONSE = {
  response_type: "ephemeral",
  text: "I'm afraid I don't understand your command. Take another sip and try again.",
};

const MAX_COFFEE_ADD = 5;
const MAX_COFFEE_SUBTRACT = 2;
const COUNT_DISPLAY_SIZE = 5;

TARGET_MIGRATION_LEVEL = 2;

const Koa = require("koa");
const Router = require("koa-router");
const bodyParser = require("koa-bodyparser");
const { DateTime } = require("luxon");
const { Pool } = require("pg");
const CronJob = require("cron").CronJob;

// http is used to forward through the incoming requests
// to the old coffeebot version in case rollback is needed
const http = require('http');

const queries = require("./queries");
const migration = require("./migration");
const backup = require("./backup");
const wordlist = require("./wordlist");
const app = new Koa();
app.use(bodyParser());

const router = new Router();

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

new CronJob(
  "00 00 02 * * *",
  async function () {
    await createBackup(pool, awsDetails);
  },
  null,
  true,
  "Australia/Melbourne"
);

function passthroughRequest(ctx) {
  /**
   * Passes through/repeats the incoming request on to another
   * host; basically just so the old coffeebot can continue
   * to process incoming data in case the new one screws up
   * or isn't working correctly.
   */
  if (REQUEST_PASSTHROUGH_HOST === null) {
    return;
  }

  const data = JSON.stringify({ ...ctx.request.body });
  setTimeout(() => {
    try {
      const options = {
        protocol: 'http:',
        hostname: REQUEST_PASSTHROUGH_HOST,
        port: REQUEST_PASSTHROUGH_PORT,
        path: ctx.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }
      const request = http.request(options);
      request.on('error', function (err) {
        console.log(`Failed to replace request: inner error ${err}`);
      });
      request.write(data);
      request.end();
    } catch (e) {
      console.log(`Failed to replay request: ${e}`);
    }
  });
}

function showHelp() {
  return {
    response_type: "ephemeral",
    text: `Ohai, and welcome to coffeebot. Coffeebot counts the coffees consumed by teams because why not.

        The most important commands are:

        - \`/coffee help\` - You found this already
        - \`/coffee\` - add a single coffee
        - \`/coffee <number>\` - add multiple coffees, max 5; but try to use /coffee when you get a coffee instead
        - \`/coffee stomach-pump\` - subtract a single coffee
        - \`/coffee -<number>\` - subtract multiple coffees, max 2; but try not to add coffees you're not drinking
        - \`/coffee count\` - show the total number of coffees, and highest 5 coffee consumers
        - \`/coffee count-all\` - show the total number of coffees, and _all_ coffee consumers
        - \`/coffee stats\` - see summary data from all coffees recorded since the beginning of the bot (currently broken)
        - \`/coffee link\` - get a code to link your user between workspaces, so you can log coffees from any of them
        - \`/coffee link <link code>\` - use a link code to link your account between workspaces
        - \`/coffee about\` - about coffeebot`,
  };
}

function showAbout(dbTeamLabel) {
  return {
    response_type: "ephemeral",
    text: `CoffeeBot is a helpful slack bot dedicated to capturing the coffee consumption habits of ${getTeamLabelOrGenericPlural(dbTeamLabel)}.\n` +
      `It was written the night before international coffee day 2020 as a something between ` +
      `a joke and an experiment in using firebase. Somehow, it has continued to be used since then (although no longer in Firebase).\n` +
      `It was created based on the idea by Bec (of 2020 Common Code) that it would be cool to know how much coffee ` +
      `team members drink. I hope you enjoy it.

   - Simeon`
  }
}



async function createDatabaseBitsIfMissing() {
  const client = await pool.connect();
  try {
    console.log("Attempting to create migrations table");
    await client.query(queries.CREATE_MIGRATION_TABLE_VX_QUERY);
    console.log("All table creation complete");
  } finally {
    await client.release();
  }
}

async function showCoffeeStats(dbTeamId, dbTeamLabel) {
  const client = await pool.connect();
  try {

    const totalCoffeeCountQuery = await client.query(
      queries.COUNT_ALL_DRINKS_EVER_V2_QUERY,
      [dbTeamId,]
    );
    const totalCoffeeCount = totalCoffeeCountQuery.rows[0].count;

    const coffeeCountByUserQuery = await client.query(
      queries.AVERAGE_USER_DRINKS_EVER_V2_QUERY,
      [dbTeamId,]
    );

    let blocks = [];
    let textChunks = [];

    coffeeCountByUserQuery.rows.forEach(row =>
      textChunks.push(
        `- _${row.user_name}_ has averaged ${Number.parseFloat(row.avg_coffees_per_day).toFixed(1)} coffees per day across ${row.reporting_days} days, for a total of ${row.total_coffees} coffees`
      )
    )

    if (textChunks.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: textChunks.join("\n"),
        },
      });
    }

    blocks.unshift({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Since CoffeeBot began it's glorious existence*, ${getTeamLabelOrGenericPlural(dbTeamLabel)} have consumed ${totalCoffeeCount} coffees`,
      },
    });

    return {
      response_type: "in_channel",
      blocks: blocks,
    };
  } finally {
    await client.release();
  }
}

function getTeamLabelOrGenericPlural(dbTeamLabel) {
  return dbTeamLabel || 'workspace members';
}

async function showCoffeeCount(dbTeamId, dbTeamLabel, numOfItems) {
  const client = await pool.connect();
  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const start_of_today = dt.set({
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    const start_of_tomorrow = dt.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });

    const totalCoffeeCountQuery = await client.query(queries.COUNT_ALL_DRINKS_V2_QUERY, [
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
      dbTeamId,
    ]);
    const totalCoffeeCount = totalCoffeeCountQuery.rows[0].count;

    const coffeeCountByUserQuery = await client.query(queries.TALLY_ALL_DRINKS_V2_QUERY, [
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
      dbTeamId,
    ]);

    let blocks = [];
    let textChunks = [];

    itemsToShow = numOfItems
      ? Math.min(numOfItems, coffeeCountByUserQuery.rows.length)
      : coffeeCountByUserQuery.rows.length;

    for (let idx = 0, len = itemsToShow; idx < len; idx++) {
      textChunks.push(
        `- _${coffeeCountByUserQuery.rows[idx].user_name}_ has consumed ${coffeeCountByUserQuery.rows[idx].drink_count} coffees`
      );
    }

    if (textChunks.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: textChunks.join("\n"),
        },
      });
    }

    blocks.unshift({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Today*, ${getTeamLabelOrGenericPlural(dbTeamLabel)} have consumed ${totalCoffeeCount} coffees`,
      },
    });

    return {
      response_type: "in_channel",
      blocks: blocks,
    };
  } finally {
    await client.release();
  }
}

async function getOrCreateTeam(teamId, teamDomain) {
  /**
   * Create a 'team' record if one doesn't already exist for the team
   * and return the database ID for the team (not the slack team_id)
   */
  const client = await pool.connect();

  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const getOrCreateTeamQuery = await client.query(
      queries.INSERT_OR_GET_TEAM_V2_QUERY,
      [dt.toISO(), teamId, teamDomain]
    );
    return { dbTeamId: getOrCreateTeamQuery.rows[0].id, dbTeamLabel: getOrCreateTeamQuery.rows[0].label };
  } catch (e) {
    console.log(`Error in getOrCreateTeam: ${e}`);
  } finally {
    await client.release();
  }
}

async function getOrCreateUser(userId, userName, dbTeamId) {
  /**
   * Create a `user` and `abstract_user` record if they don't
   * already exist for the user and return the IDs
   */
  const client = await pool.connect();

  try {
    // If there is an existing user set up, just return the details
    getUserQuery = await client.query(queries.GET_USER_V2_QUERY, [userId, dbTeamId]);
    if (getUserQuery.rows.length > 0) {
      // If the user's slack name has changed, update it in the user table
      const dbUserId = getUserQuery.rows[0].id;
      if (getUserQuery.rows[0].user_name !== userName) {
        await client.query(queries.UPDATE_USER_NAME_V2_QUERY, [dbUserId, userName])
      }
      return {
        dbAbstractUserId: getUserQuery.rows[0].abstract_user_id,
        dbUserId: dbUserId,
        dbUserIsAdmin: getUserQuery.rows[0].is_admin,
      };
    }

    // User doesn't exist - we need to create them
    try {
      await client.query(queries.BEGIN);
      const dt = DateTime.local().setZone("Australia/Melbourne");

      // Create a new abstract user to link to
      const insertAbstractUserQuery = await client.query(queries.INSERT_ABSTRACT_USER_V2_QUERY, [dt.toISO()]);
      const dbAbstractUserId = insertAbstractUserQuery.rows[0].id

      // Create the main user record - this is created with an insert with on conflict
      // in case something else slipped in an insert on us
      const getOrCreateUserQuery = await client.query(
        queries.INSERT_OR_GET_USER_V2_QUERY,
        [dt.toISO(), userId, userName, dbAbstractUserId, dbTeamId]
      );

      await client.query(queries.COMMIT);

      return {
        dbAbstractUserId: getOrCreateUserQuery.rows[0].abstract_user_id,
        dbUserId: getOrCreateUserQuery.rows[0].id,
        dbUserIsAdmin: getOrCreateUserQuery.rows[0].is_admin,
      };
    } catch (e) {
      console.log(`Error in getOrCreateUser: ${e}`)
      await client.query(queries.ROLLBACK);
    }
  } finally {
    await client.release();
  }
}

async function addCoffee(dbAbstractUserId, dbUserId, dbTeamId, dbTeamLabel, inc) {
  if (inc > MAX_COFFEE_ADD) {
    return {
      response_type: "ephemeral",
      text: "You can't add more than 5 coffees at a time",
    };
  }

  if (-1 * inc > MAX_COFFEE_SUBTRACT) {
    return {
      response_type: "ephemeral",
      text: "You can't remove more than 2 coffees at a time",
    };
  }

  const client = await pool.connect();
  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const start_of_today = dt.set({
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    const start_of_tomorrow = dt.plus({ days: 1 }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });

    if (inc > 0) {
      for (let idx = 0; idx < inc; idx++) {
        await client.query(
          queries.ADD_DRINK_V2_QUERY,
          [dbAbstractUserId, dbUserId, dt.toISO()]
        );
      }
    } else if (inc < 0) {
      await client.query(
        queries.DELETE_N_MOST_RECENT_DRINKS_FOR_USER_V2_QUERY,
        [dbAbstractUserId, start_of_today.toISO(), start_of_tomorrow.toISO(), -1 * inc,]
      );
    }

    const totalCoffeeCountQuery = await client.query(queries.COUNT_ALL_DRINKS_V2_QUERY, [
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
      dbTeamId,
    ]);
    const totalCoffeeCount = totalCoffeeCountQuery.rows[0].count;
    const userCoffeeCountQuery = await client.query(queries.COUNT_USER_DRINKS_V2_QUERY, [
      dbAbstractUserId,
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
    ]);
    const userCoffeeCount = userCoffeeCountQuery.rows[0].count;

    return {
      response_type: "ephemeral",
      text: `That's coffee number ${userCoffeeCount} for you today, and number ${totalCoffeeCount} for ${getTeamLabelOrGenericPlural(dbTeamLabel)} today`,
    };
  } finally {
    await client.release();
  }
}

async function getLinkCode(dbAbstractUserId) {
  const words = wordlist.getWords(4);
  const dt = DateTime.local().setZone("Australia/Melbourne");
  const client = await pool.connect();

  try {
    await client.query(queries.INSERT_LINK_WORDS_V2_QUERY, [dbAbstractUserId, words, dt.toISO()]);
    return {
      response_type: "ephemeral",
      text: `Your link code is ${words}. To link another workspace enter /coffee link ${words}`,
    };
  } catch (e) {
    console.log(`Error in getLinkCode: ${e}`);
  } finally {
    await client.release();
  }
}

async function linkUserByCode(dbAbstractUserId, words) {
  const dt = DateTime.local().setZone("Australia/Melbourne");
  const dtLinkCutoff = dt.minus({ days: 1 });
  const client = await pool.connect();

  try {
    // This could probably all be done in a single query
    // and there is also possibly a race condition here, although
    // hopefully mitigated by a transaction error if two
    // clients simultaneously try to delete the same link
    // word record
    client.query(queries.BEGIN);
    const getAbstractUserForLinkWordQuery = await client.query(
      queries.GET_ABSTRACT_USER_FOR_LINK_WORD_V2_QUERY,
      [words, dtLinkCutoff.toISO()]
    );

    // Delete the link word if it exists; it has either been consumed,
    // is too old, or never existing at this point
    await client.query(
      queries.DELETE_LINK_WORD_V2_QUERY,
      [words,]
    );

    if (getAbstractUserForLinkWordQuery.rows.length < 1) {
      return {
        response_type: "ephemeral",
        text: `The link code ${words} could not be found or is too old. Use /coffee link to get a new link code`,
      };
    }

    const newDbAbstractUserId = getAbstractUserForLinkWordQuery.rows[0].abstract_user_id;
    await client.query(
      queries.UPDATE_ABSTRACT_USER_FOR_DRINKS_V2_QUERY,
      [dbAbstractUserId, newDbAbstractUserId]
    );

    await client.query(
      queries.UPDATE_ABSTRACT_USER_FOR_USER_V2_QUERY,
      [dbAbstractUserId, newDbAbstractUserId]
    );

    await client.query(queries.COMMIT);
    return {
      response_type: "ephemeral",
      text: `Your slack user has been linked successfully`,
    };
  } catch (e) {
    console.log(`Error in linkUserByCode: ${e}`);
    client.query(queries.ROLLBACK);
  } finally {
    await client.release();
  }
}


async function makeAdmin(dbUserId, identifierKey, dbUserId, dbUserIsAdmin, userId, userName) {
  /**
   * Given the correct 'admin key' (which is static, which is bad)
   * sets the calling user to be an `admin`
   */
  if (ADMIN_KEY === null || ADMIN_KEY === "") {
    console.log(`Attempt to identify as admin without ADMIN_KEY set: ${dbUserId}:${userId}:${userName}`)
    // We return the generic error message for failed attempts to identify
    return GENERIC_FAILURE_RESPONSE;
  }

  if (identifierKey !== ADMIN_KEY) {
    console.log(`Failed attempt to identify as admin: ${dbUserId}:${userId}:${userName}`)
    // We return the generic error message for failed attempts to identify
    return GENERIC_FAILURE_RESPONSE;
  }

  const client = await pool.connect();

  try {
    const makeAdminIfNotAlreadyQuery = await client.query(queries.MAKE_ADMIN_IF_NOT_ALREADY_V2_QUERY, [dbUserId,]);
    if (makeAdminIfNotAlreadyQuery.rowCount == 0) {
      console.log(`Failed to identify as admin; may already be admin? ${dbUserId}:${userId}:${userName} isAdmin ${dbUserIsAdmin}`)
      return GENERIC_FAILURE_RESPONSE;
    } else {
      console.log(`Identified as admin: ${dbUserId}:${userId}:${userName}`)
      return { ...GENERIC_FAILURE_RESPONSE, text: `${GENERIC_FAILURE_RESPONSE.text} ;)` };
    }
  } catch (e) {
    console.log(`makeAdmin failed for user ${dbUserId}:${userId}:${userName}: ${e}`);
  } finally {
    await client.release()
  }
}

async function setTeamLabel(dbTeamId, teamLabel, dbUserId, dbUserIsAdmin, userId, userName) {
  /**
   * Updates the label of the team to be used when outputting messages. (e.g. Common Coders)
   * 
   * MUST ONLY BE CALLED BY AN ADMIN. THIS FUNCTION DOES ONLY A TRIVIAL SECURITY CHECK.
   */
  if (!dbUserIsAdmin) {
    console.log(`setTeamLabel was called with dbUserIsAdmin false (User: ${dbUserId}). Please check your values!`);
    return GENERIC_FAILURE_RESPONSE;
  }
  const client = await pool.connect();

  try {
    console.log(`User setting team label. User: ${dbUserId}:${userId}:${userName} TeamId: ${dbTeamId} Label ${teamLabel}`);
    await client.query(queries.SET_TEAM_LABEL_V2, [dbTeamId, teamLabel]);
    return {
      response_type: "in_channel",
      text: `The workspace team name has been set to ${teamLabel} by ${userName}`,
    };
  } catch (e) {
    console.log(`setTeamLabel failed for user ${dbUserId}:${userId}:${userName}: ${e}`);
  } finally {
    await client.release()
  }
}

async function getMyInfo(dbTeamId, teamId, teamDomain, dbTeamLabel, dbAbstractUserId, dbUserId, dbUserIsAdmin, userId, userName) {
  /**
   * Outputs a summary of the current user context for debugging
   */
  return {
    response_type: "ephemeral",
    text: `You are on team ${dbTeamId}:${teamId}:${teamDomain}:${dbTeamLabel}\nuser ${dbAbstractUserId}:${dbUserId}:${userId}:${userName}. Your is_admin value is ${dbUserIsAdmin}`,
  };
}

PERMISSION_SLACKACTION = "SLACK_ACTION";

async function hasPermission(ctx, action) {
  /**
   * Check that the current user has the specified permission,
   * except that right now the 'permission' is ignored and it
   * is just a dumb key check
   */
  return ctx.request.query.key === AUTH_KEY;
}

router.post("/addCoffee", async (ctx, next) => {
  // The permissions are a lie - whatever action you
  // pass it does the same thing
  if (!hasPermission(ctx, PERMISSION_SLACKACTION)) {
    ctx.body = { result: "nope" };
    return;
  }

  passthroughRequest(ctx);

  if (ctx.request.body.command !== "/coffee") {
    ctx.body = {
      response_type: "ephemeral",
      text: "Something has gone horribly wrong",
    };
    return;
  }

  if (ctx.request.body.text === "migrate") {
    ctx.body = await migration.runMigrations(
      pool,
      ctx.request.body.user_id,
      ctx.request.body.user_name,
      ctx.request.body.team_id,
      ctx.request.body.team_domain,
    )
    return;
  }

  if (await migration.areMigrationsPending(pool)) {
    ctx.body = {
      response_type: "ephemeral",
      text: "Migrations must be run before continuing",
    };
    return;
  }

  const { dbTeamId, dbTeamLabel } = await getOrCreateTeam(
    ctx.request.body.team_id,
    ctx.request.body.team_domain
  );
  const { dbAbstractUserId, dbUserId, dbUserIsAdmin } = await getOrCreateUser(
    ctx.request.body.user_id,
    ctx.request.body.user_name,
    dbTeamId
  );

  if (ctx.request.body.text === "help") {
    ctx.body = showHelp();
    return;
  } else if (ctx.request.body.text === "about") {
    ctx.body = showAbout(dbTeamLabel);
    return;
  } else if (ctx.request.body.text === "link") {
    ctx.body = await getLinkCode(dbAbstractUserId);
    return;
  } else if (ctx.request.body.text.startsWith("link ")) {
    const linkWords = ctx.request.body.text.substring("link ".length);
    ctx.body = await linkUserByCode(dbAbstractUserId, linkWords);
    return;
  } else if (ctx.request.body.text === "count") {
    ctx.body = await showCoffeeCount(dbTeamId, dbTeamLabel, COUNT_DISPLAY_SIZE);
    return;
  } else if (ctx.request.body.text === "count-all") {
    ctx.body = await showCoffeeCount(dbTeamId, dbTeamLabel, null);
    return;
  } else if (ctx.request.body.text === "stats") {
    ctx.body = await showCoffeeStats(dbTeamId, dbTeamLabel);
    return;
  } else if (ctx.request.body.text === "stomach-pump") {
    ctx.body = await addCoffee(dbAbstractUserId, dbUserId, dbTeamId, dbTeamLabel, -1);
    return;
  } else if (!isNaN(parseInt(ctx.request.body.text, 10))) {
    ctx.body = await addCoffee(
      dbAbstractUserId,
      dbUserId,
      dbTeamId,
      dbTeamLabel,
      parseInt(ctx.request.body.text, 10)
    );
    return;
  } else if (ctx.request.body.text === "") {
    ctx.body = await addCoffee(dbAbstractUserId, dbUserId, dbTeamId, dbTeamLabel, 1);
    return;
  } else if (ctx.request.body.text.startsWith("auth ")) {
    const identifierKey = ctx.request.body.text.substring("auth ".length);
    ctx.body = await makeAdmin(
      dbUserId,
      identifierKey,
      dbUserId,
      dbUserIsAdmin,
      ctx.request.body.user_id,
      ctx.request.body.user_name
    );
    return;
  } else if (dbUserIsAdmin && ctx.request.body.text.startsWith("teamlabel ")) {
    const teamLabel = ctx.request.body.text.substring("teamlabel ".length);
    ctx.body = await setTeamLabel(
      dbTeamId,
      teamLabel,
      dbUserId,
      dbUserIsAdmin,
      ctx.request.body.user_id,
      ctx.request.body.user_name
    );
    return;
  } else if (dbUserIsAdmin && ctx.request.body.text == "myinfo") {
    ctx.body = await getMyInfo(
      dbTeamId,
      ctx.request.body.team_id,
      ctx.request.body.team_domain,
      dbTeamLabel,
      dbAbstractUserId,
      dbUserId,
      dbUserIsAdmin,
      ctx.request.body.user_id,
      ctx.request.body.user_name
    );
    return;
  } else if (dbUserIsAdmin && ctx.request.body.text === "backup") {
    ctx.body = await backup.createBackup(pool, awsDetails);
    return;
  } else if (dbUserIsAdmin && ctx.request.body.text === "backup-all") {
    ctx.body = await backup.createFullBackup(pool, awsDetails);
    return;
  } else {
    ctx.body = GENERIC_FAILURE_RESPONSE;
    return;
  }
});

app.use(router.routes()).use(router.allowedMethods());

app.listen(3000, async () => {
  await createDatabaseBitsIfMissing();

  console.log("running on port 3000");

  console.log({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT,
    key: process.env.AUTH_KEY,
  });
});
