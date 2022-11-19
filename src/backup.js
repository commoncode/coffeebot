const queries = require("./queries");
const { DateTime } = require("luxon");
const AWS = require("aws-sdk");
const { LexModelBuildingService } = require("aws-sdk");

BACKUP_SINCE_QUERIES = [
  { tableName: "abstract_user_v2", query: queries.BACKUP_ABSTRACT_USER_SINCE_DATE_V2_QUERY },
  { tableName: "team_v2", query: queries.BACKUP_TEAM_SINCE_DATE_V2_QUERY },
  { tableName: "user_v2", query: queries.BACKUP_USER_SINCE_DATE_V2_QUERY },
  { tableName: "drink_v2", query: queries.BACKUP_DRINK_SINCE_DATE_V2_QUERY },
]

BACKUP_FULL_QUERIES = [
  { tableName: "abstract_user_v2", query: queries.BACKUP_ABSTRACT_USER_ALL_V2_QUERY },
  { tableName: "team_v2", query: queries.BACKUP_TEAM_ALL_V2_QUERY },
  { tableName: "user_v2", query: queries.BACKUP_USER_ALL_V2_QUERY },
  { tableName: "drink_v2", query: queries.BACKUP_DRINK_ALL_V2_QUERY },]

async function createBackup(pool, awsDetails) {
  console.log("Commencing incremental backup");
  const client = await pool.connect();

  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const getLastSuccessfulBackupQuery = await client.query(queries.GET_LAST_SUCCESSFUL_BACKUP_DATETIME_QUERY);

    let backupFromDate = DateTime.fromSeconds(0);
    if (getLastSuccessfulBackupQuery.rows.length > 0) {
      backupFromDate = DateTime.fromJSDate(
        getLastSuccessfulBackupQuery.rows[0].backup_until
      );
    }

    const rowsToBackUp = Array();

    for ({ tableName, query } of BACKUP_SINCE_QUERIES) {
      const queryResult = await client.query(query, [
        backupFromDate.toISO(),
      ]);

      for (row of queryResult.rows) {
        rowsToBackUp.push(JSON.stringify({ tableName: tableName, ...row }))
      }
    }

    const s3 = new AWS.S3({
      accessKeyId: awsDetails.AWS_ACCESS_KEY_ID,
      secretAccessKey: awsDetails.AWS_SECRET_KEY,
      region: awsDetails.AWS_REGION,
    });

    const params = {
      Bucket: awsDetails.AWS_BUCKET_NAME,
      Key: `${awsDetails.AWS_BACKUP_FOLDER}/${dt.toISO()}.v2.rows.incremental.json`,
      Body: rowsToBackUp.join("\n"),
    };

    try {
      await s3.upload(params).promise();
      await client.query(queries.CREATE_BACKUP_ROW_QUERY, [dt.toISO(), dt.toISO(), true, ""]);
      const message = `${rowsToBackUp.length} rows backed up. Filename: ${params.Key}.`;
      console.log(message);
      return {
        response_type: "ephemeral",
        text: message,
      };
    } catch (err) {
      await client.query(queries.CREATE_BACKUP_ROW_QUERY, [dt.toISO(), dt.toISO(), false, err]);
      const message = `Incremental backup error: ${err}`;
      console.log(message);
      return { response_type: "ephemeral", text: message };
    }
  } finally {
    await client.release();
  }
}

async function createFullBackup(pool, awsDetails) {
  console.log("Commencing full backup");
  const client = await pool.connect();

  try {
    const dt = DateTime.local().setZone("Australia/Melbourne");
    const rowsToBackUp = Array();

    for ({ tableName, query } of BACKUP_FULL_QUERIES) {
      const queryResult = await client.query(query);

      for (row of queryResult.rows) {
        rowsToBackUp.push(JSON.stringify({ tableName: tableName, ...row }))
      }
    }

    const s3 = new AWS.S3({
      accessKeyId: awsDetails.AWS_ACCESS_KEY_ID,
      secretAccessKey: awsDetails.AWS_SECRET_KEY,
      region: awsDetails.AWS_REGION,
    });

    const params = {
      Bucket: awsDetails.AWS_BUCKET_NAME,
      Key: `${awsDetails.AWS_BACKUP_FOLDER}/${dt.toISO()}.v2.rows.full.json`,
      Body: rowsToBackUp.join("\n"),
    };

    try {
      await s3.upload(params).promise();
      await client.query(queries.CREATE_BACKUP_ROW_QUERY, [dt.toISO(), dt.toISO(), true, ""]);
      const message = `${rowsToBackUp.length} rows backed up. Filename: ${params.Key}.`;
      console.log(message);
      return {
        response_type: "ephemeral",
        text: message,
      };
    } catch (err) {
      await client.query(queries.CREATE_BACKUP_ROW_QUERY, [dt.toISO(), dt.toISO(), false, err]);
      const message = `Full backup error: ${err}`;
      console.log(message);
      return { response_type: "ephemeral", text: message };
    }
  } finally {
    await client.release();
  }
}

module.exports = {
  createBackup,
  createFullBackup,
}