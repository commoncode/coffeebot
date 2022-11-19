require("dotenv").config();
require("./queries");
const AUTH_KEY = process.env.AUTH_KEY;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
const AWS_BUCKET_NAME = process.env.AWS_BUCKET_NAME;
const AWS_BACKUP_FOLDER = process.env.AWS_BACKUP_FOLDER;
const AWS_REGION = process.env.AWS_REGION;

const MAX_COFFEE_ADD = 5;
const MAX_COFFEE_SUBTRACT = 2;
const COUNT_DISPLAY_SIZE = 5;

TARGET_MIGRATION_LEVEL = 1;

const Koa = require("koa");
const Router = require("koa-router");
const bodyParser = require("koa-bodyparser");
const { DateTime } = require("luxon");
const { Pool } = require("pg");
const AWS = require("aws-sdk");
const queries = require("./queries");
const CronJob = require("cron").CronJob;

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
    await createBackup();
  },
  null,
  true,
  "Australia/Melbourne"
);

function showHelp() {
  return {
    response_type: "ephemeral",
    text: `Ohai, and welcome to coffeebot. Coffeebot counts the coffees consumed by Common Coders because why not.

        The most important commands are:

        - \`/coffee help\` - You found this already
        - \`/coffee\` - add a single coffee
        - \`/coffee <number>\` - add multiple coffees, max 5; but try to use /coffee when you get a coffee instead
        - \`/coffee stomach-pump\` - subtract a single coffee
        - \`/coffee -<number>\` - subtract multiple coffees, max 2; but try not to add coffees you're not drinking
        - \`/coffee count\` - show the total number of coffees, and highest 5 coffee consumers
        - \`/coffee count-all\` - show the total number of coffees, and _all_ coffee consumers
        - \`/coffee stats\` - see summary data from all coffees recorded since the beginning of the bot
        - \`/coffee about\` - about coffeebot`,
  };
}

function showAbout() {
  return {
    response_type: "ephemeral",
    text: `Coffeebot was written the night before international coffee 2020 as a combination between a joke and
an experiment in using firebase. Somehow, it has continued to be used since then. I hope you like it.

   - Simeon`
  }
}

async function runMigrations(userId, userName, teamId, teamDomain) {
  /***
   * Run migrations on the database if required. This can be run by any user (which is a bit
   * dubious, but the command also isn't listed anywhere and should be idempotent so 🤷 gotta
   * start somewhere)
   * 
   * @param {string} userId - the slack user_id issuing the migrate command
   * @param {string} userName - the slack user name issuing the migrate command
   * @param {string} teamId - the workspace team_id from which the migrate command is being issued
   * @param {string} teamDomain - the workspace team_domain from which the migrate command is being issued
   */

  const client = await pool.connect();

  try {
    await client.query(queries.BEGIN);
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const getCurrentMigrationLevelQuery = await client.query(queries.GET_MIGRATION_LEVEL);

    // If there are no migration rows, the max value is null
    let currentMigrationLevel = getCurrentMigrationLevelQuery.rows[0].migration_level;
    console.log(`Current migration level: ${currentMigrationLevel}`);

    if (currentMigrationLevel === null) {
      console.log(`Applying migration level 1`);
      await client.query(queries.CREATE_ABSTRACT_USER_TABLE_V1_QUERY);
      await client.query(queries.CREATE_TEAM_TABLE_V1_QUERY);
      await client.query(queries.CREATE_TEAM_USER_TABLE_V1_QUERY);
      await client.query(queries.CREATE_ABSTRACT_USER_DRINK_TABLE_V1_QUERY);

      // Now to migrate the data.
      // There is an assumption here that all the current data comes from
      // the workspace from which the migration is being run.
      // If that isn't the case... well, just make sure it is the case OK?
      // This could no doubt be implemented directly in SQL, but that's a
      // future thing to think about

      // Create the team record
      insertTeamQuery = await client.query(queries.INSERT_OR_GET_TEAM_V1_QUERY, [dt.toISO(), teamId, teamDomain]);
      dbTeamId = insertTeamQuery.rows[0].id

      // Get a list of distinct users from the drinks table
      getDistinctUsersQuery = await client.query(queries.MIGRATION_V1_GET_DISTINCT_USERS_QUERY);

      for (row of getDistinctUsersQuery.rows) {
        // Create an abstract user and get back the identifier
        const insertAbstractUserQuery = await client.query(queries.INSERT_ABSTRACT_USER_V1_QUERY, [dt.toISO()]);
        const dbAbstractUserId = insertAbstractUserQuery.rows[0].id

        // Create a user record for each distinct user from the drinks table
        // on the current team_id pointing to the abstract user and team record
        await client.query(queries.INSERT_USER_V1_QUERY, [dt.toISO(), row.user_id, row.user_name, dbTeamId, dbAbstractUserId])
      }

      // Once that has been done for all users, run a single SQL command
      // to migrate all the drinks that have been recorded
      await client.query(queries.MIGRATION_V1_COPY_DRINKS)
      // Step 3 ... Profit?
      await client.query(queries.MIGRATION_V1_SET_MIGRATION_LEVEL, [1, dt.toISO()]);
      await client.query(queries.COMMIT);
      console.log(`Migration level 1 applied successfully`);
    }
    // Add additional migrations here
    console.log(`All necessary migrations applied successfully`);
    return {
      response_type: "ephemeral",
      text: `Migrations ran successfully`,
    };
  } catch (e) {
    await client.query(queries.ROLLBACK);
    console.log(`Migrations failed to apply: ${e}`);
    return {
      response_type: "ephemeral",
      text: `Migrations failed to apply`,
    };
  } finally {
    await client.release();
  }
}

async function areMigrationsPending() {
  /**
   * Check if any migrations are pending, and return an error if so
   */
  const client = await pool.connect();
  try {
    const getCurrentMigrationLevelQuery = await client.query(queries.GET_MIGRATION_LEVEL);

    // If there are no migration rows, the max value is null
    const currentMigrationLevel = getCurrentMigrationLevelQuery.rows[0].migration_level;
    return currentMigrationLevel === null || currentMigrationLevel < TARGET_MIGRATION_LEVEL;
  } finally {
    await client.release();
  }
}

async function createBackup() {
  const client = await pool.connect();

  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const getLastSuccessfulBackupQuery = await client.query(queries.GET_LAST_SUCCESSFUL_BACKUP_DATETIME_QUERY);

    let backupFromDate = DateTime.fromSeconds(0);
    if (getLastSuccessfulBackupQuery.rows.length > 0) {
      backupFromDate = DateTime.fromJSDate(getLastSuccessfulBackupQuery.rows[0].backup_until);
    }

    const getAllDrinksSinceDatetimeQuery = await client.query(queries.ALL_DRINKS_SINCE_DATETIME_QUERY, [
      backupFromDate.toISO(),
    ]);
    allDrinksSinceDatetime = getAllDrinksSinceDatetimeQuery.rows;

    if (allDrinksSinceDatetime.length === 0) {
      return {
        response_type: "ephemeral",
        text: `No entries since ${backupFromDate.toISO()} to back up.`,
      };
    }

    const rowsToBackUp = Array();
    let maxDate = DateTime.fromSeconds(0);

    for (let idx = 0, len = allDrinksSinceDatetime.length; idx < len; idx++) {
      rowsToBackUp.push(
        JSON.stringify({
          id: allDrinksSinceDatetime[idx].id,
          user_id: allDrinksSinceDatetime[idx].user_id,
          user_name: allDrinksSinceDatetime[idx].user_name,
          created_at: allDrinksSinceDatetime[idx].created_at,
        })
      );
      let thisDate = DateTime.fromJSDate(allDrinksSinceDatetime[idx].created_at);
      console.log(thisDate);
      if (thisDate > maxDate) {
        maxDate = thisDate;
      }
    }

    const s3 = new AWS.S3({
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_KEY,
      region: AWS_REGION,
    });

    const params = {
      Bucket: AWS_BUCKET_NAME,
      Key: `${AWS_BACKUP_FOLDER}/${maxDate.toISO()}.rows.incremental.json`,
      Body: rowsToBackUp.join("\n"),
    };

    try {
      await s3.upload(params).promise();
      await client.query(queries.CREATE_BACKUP_ROW_QUERY, [dt.toISO(), maxDate.toISO(), true, ""]);
      return {
        response_type: "ephemeral",
        text: `${allDrinksSinceDatetime.length} entries backed up. Filename: ${params.Key}.`,
      };
    } catch (err) {
      await client.query(queries.CREATE_BACKUP_ROW_QUERY, [dt.toISO(), maxDate.toISO(), false, err]);
      return { response_type: "ephemeral", text: `Backup error: ${err}` };
    }
  } finally {
    await client.release();
  }
}

async function createFullBackup() {
  const client = await pool.connect();

  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const getAllDrinksQuery = await client.query(queries.ALL_DRINKS_QUERY);
    allDrinks = getAllDrinksQuery.rows;

    if (allDrinks.length === 0) {
      return {
        response_type: "ephemeral",
        text: "No entries, ever, to back up - which seems weird and wrong"
      };
    }

    rowsToBackUp = allDrinks.map(data =>
      JSON.stringify({
        id: data.id,
        user_id: data.user_id,
        user_name: data.user_name,
        created_at: data.created_at,
      })
    )

    const s3 = new AWS.S3({
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_KEY,
      region: AWS_REGION,
    });

    const params = {
      Bucket: AWS_BUCKET_NAME,
      Key: `${AWS_BACKUP_FOLDER}/${dt.toISO()}.rows.full.json`,
      Body: rowsToBackUp.join("\n"),
    };

    try {
      await s3.upload(params).promise();
      return {
        response_type: "ephemeral",
        text: `${allDrinks.length} entries backed up. Filename: ${params.Key}.`,
      };
    } catch (err) {
      return { response_type: "ephemeral", text: `Backup error: ${err}` };
    }
  } finally {
    await client.release();
  }
}

async function createDatabaseBitsIfMissing() {
  const client = await pool.connect();
  try {
    console.log("Attempting to create drink table");
    await client.query(queries.CREATE_DRINK_TABLE_QUERY);
    console.log("Attempting to create backup table");
    await client.query(queries.CREATE_BACKUP_TABLE_QUERY);
    console.log("Attempting to create migrations table");
    await client.query(queries.CREATE_MIGRATION_TABLE_QUERY);
    console.log("All table creation complete");
  } finally {
    await client.release();
  }
}

async function showCoffeeStats() {
  const client = await pool.connect();
  try {

    const totalCoffeeCountQuery = await client.query(queries.COUNT_ALL_DRINKS_EVER_QUERY);
    const totalCoffeeCount = totalCoffeeCountQuery.rows[0].count;

    const coffeeCountByUserQuery = await client.query(queries.AVERAGE_USER_DRINKS_EVER_QUERY);

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
        text: `*Since CoffeeBot began it's glorious existence*, Common Coders have consumed ${totalCoffeeCount} coffees`,
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

async function showCoffeeCount(numOfItems) {
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

    const totalCoffeeCountQuery = await client.query(queries.COUNT_ALL_DRINKS_QUERY, [
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
    ]);
    const totalCoffeeCount = totalCoffeeCountQuery.rows[0].count;

    const coffeeCountByUserQuery = await client.query(queries.TALLY_ALL_DRINKS_QUERY, [
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
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
        text: `*Today*, Common Coders have consumed ${totalCoffeeCount} coffees`,
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
    const getOrCreateTeamQuery = client.query(queries.INSERT_OR_GET_TEAM_V1_QUERY, [to.toISO(), teamId, teamDomain]);
    return getOrCreateTeamQuery.rows[0].id
  } finally {
    client.release();
  }
}




async function getOrCreateUser(userId, userName, dbTeamId) {

}

async function addCoffee(userId, userName, teamId, teamDomain, inc) {
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
        await client.query(queries.ADD_DRINK_QUERY, [userId, userName, dt.toISO()]);
      }
    } else if (inc < 0) {
      await client.query(queries.DELETE_N_MOST_RECENT_DRINKS_FOR_USER_QUERY, [
        userId,
        start_of_today.toISO(),
        start_of_tomorrow.toISO(),
        -1 * inc,
      ]);
    }

    const totalCoffeeCountQuery = await client.query(queries.COUNT_ALL_DRINKS_QUERY, [
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
    ]);
    const totalCoffeeCount = totalCoffeeCountQuery.rows[0].count;
    const userCoffeeCountQuery = await client.query(queries.COUNT_USER_DRINKS_QUERY, [
      userId,
      start_of_today.toISO(),
      start_of_tomorrow.toISO(),
    ]);
    const userCoffeeCount = userCoffeeCountQuery.rows[0].count;

    return {
      response_type: "ephemeral",
      text: `That's coffee number ${userCoffeeCount} for you today, and number ${totalCoffeeCount} for CC today`,
    };
  } finally {
    await client.release();
  }
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

  if (ctx.request.body.command !== "/coffee") {
    ctx.body = {
      response_type: "ephemeral",
      text: "Something has gone horribly wrong",
    };
    return;
  }

  if (ctx.request.body.text === "migrate") {
    ctx.body = await runMigrations(
      ctx.request.body.user_id,
      ctx.request.body.user_name,
      ctx.request.body.team_id,
      ctx.request.body.team_domain,
    )
    return;
  }

  if (await areMigrationsPending()) {
    ctx.body = {
      response_type: "ephemeral",
      text: "Migrations must be run before continuing",
    };
    return;
  }


  if (ctx.request.body.text === "help") {
    ctx.body = showHelp();
    return;
  } else if (ctx.request.body.text === "about") {
    ctx.body = showAbout();
    return;
  } else if (ctx.request.body.text === "count") {
    ctx.body = await showCoffeeCount(COUNT_DISPLAY_SIZE);
    return;
  } else if (ctx.request.body.text === "count-all") {
    ctx.body = await showCoffeeCount(null);
    return;
  } else if (ctx.request.body.text === "stats") {
    ctx.body = await showCoffeeStats(null);
    return;
  } else if (ctx.request.body.text === "stomach-pump") {
    ctx.body = await addCoffee(ctx.request.body.user_id, ctx.request.body.user_name, -1);
    return;
  } else if (!isNaN(parseInt(ctx.request.body.text, 10))) {
    ctx.body = await addCoffee(
      ctx.request.body.user_id,
      ctx.request.body.user_name,
      ctx.request.body.team_id,
      ctx.request.body.team_domain,
      parseInt(ctx.request.body.text, 10)
    );
    return;
  } else if (ctx.request.body.text === "") {
    ctx.body = await addCoffee(ctx.request.body.user_id, ctx.request.body.user_name, 1);
    return;
  } else if (ctx.request.body.text === "backup") {
    ctx.body = await createBackup();
    return;
  } else if (ctx.request.body.text === "backup-all") {
    ctx.body = await createFullBackup();
    return;
  } else {
    ctx.body = {
      response_type: "ephemeral",
      text: "I'm afraid I don't understand your command. Take another sip and try again.",
    };
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
