const queries = require("./queries");
const { DateTime } = require("luxon");

async function runMigrations(pool, userId, userName, teamId, teamDomain) {
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
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const getCurrentMigrationLevelQuery = await client.query(queries.GET_MIGRATION_VX_LEVEL);

    // If there are no migration rows, the max value is null
    let currentMigrationLevel = getCurrentMigrationLevelQuery.rows[0].migration_level;
    console.log(`Current migration level: ${currentMigrationLevel}`);

    if (currentMigrationLevel === null) {
      await client.query(queries.BEGIN);
      console.log("Attempting to create drink table");
      await client.query(queries.CREATE_DRINK_TABLE_V1_QUERY);
      console.log("Attempting to create backup table");
      await client.query(queries.CREATE_BACKUP_TABLE_QUERY);
      await client.query(queries.MIGRATION_V2_SET_MIGRATION_LEVEL, [1, dt.toISO()]);
      await client.query(queries.COMMIT);
      currentMigrationLevel = 1;
    }
    if (currentMigrationLevel < 2) {
      console.log(`Applying migration level 2`);
      await client.query(queries.BEGIN);
      await client.query(queries.CREATE_ABSTRACT_USER_TABLE_V2_QUERY);
      await client.query(queries.CREATE_TEAM_TABLE_V2_QUERY);
      await client.query(queries.CREATE_USER_TABLE_V2_QUERY);
      await client.query(queries.CREATE_DRINK_TABLE_V2_QUERY);
      await client.query(queries.CREATE_LINK_WORDS_TABLE_V2_QUERY);

      // Now to migrate the data.
      // There is an assumption here that all the current data comes from
      // the workspace from which the migration is being run.
      // If that isn't the case... well, just make sure it is the case OK?
      // This could no doubt be implemented directly in SQL, but that's a
      // future thing to think about

      // Create the team record
      const insertTeamQuery = await client.query(queries.INSERT_OR_GET_TEAM_V2_QUERY, [dt.toISO(), teamId, teamDomain]);
      const dbTeamId = insertTeamQuery.rows[0].id;

      // Get a list of distinct users from the drinks table
      const getDistinctUsersQuery = await client.query(queries.MIGRATION_V2_GET_DISTINCT_USERS_QUERY);

      for (row of getDistinctUsersQuery.rows) {
        // Create an abstract user and get back the identifier
        const insertAbstractUserQuery = await client.query(queries.INSERT_ABSTRACT_USER_V2_QUERY, [dt.toISO()]);
        const dbAbstractUserId = insertAbstractUserQuery.rows[0].id

        // Create a user record for each distinct user from the drinks table
        // on the current team_id pointing to the abstract user and team record
        await client.query(queries.INSERT_USER_V2_QUERY, [dt.toISO(), row.user_id, row.user_name, dbTeamId, dbAbstractUserId])
      }

      // Once that has been done for all users, run a single SQL command
      // to migrate all the drinks that have been recorded
      await client.query(queries.MIGRATION_V2_COPY_DRINKS)
      // Step 3 ... Profit?
      await client.query(queries.MIGRATION_V2_SET_MIGRATION_LEVEL, [2, dt.toISO()]);
      await client.query(queries.COMMIT);
      console.log(`Migration level 2 applied successfully`);
      currentMigrationLevel = 2;
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

async function areMigrationsPending(pool) {
  /**
   * Check if any migrations are pending, and return an error if so
   */
  const client = await pool.connect();
  try {
    const getCurrentMigrationLevelQuery = await client.query(queries.GET_MIGRATION_VX_LEVEL);

    // If there are no migration rows, the max value is null
    const currentMigrationLevel = getCurrentMigrationLevelQuery.rows[0].migration_level;
    return currentMigrationLevel === null || currentMigrationLevel < TARGET_MIGRATION_LEVEL;
  } finally {
    await client.release();
  }
}

module.exports = {
  runMigrations,
  areMigrationsPending,
}