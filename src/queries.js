module.exports = {
    BEGIN: 'BEGIN;',
    ROLLBACK: 'ROLLBACK',
    COMMIT: 'COMMIT',
    CREATE_ABSTRACT_USER_TABLE_V1_QUERY: `
        CREATE TABLE IF NOT EXISTS public.abstract_user_v1
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            PRIMARY KEY (id)
        );`,

    CREATE_TEAM_TABLE_V1_QUERY: `
        CREATE TABLE IF NOT EXISTS public.team_v1
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            -- team_id is the slack team id
            team_id character varying(50) NOT NULL,
            team_domain character varying(200) NOT NULL,
            -- label is an optional label for the team
            -- to allow a particular header to be used on the
            -- output. Not currently implemented.
            label character varying(200),
            PRIMARY KEY (id),
            CONSTRAINT team_v1_team_id_unique UNIQUE (team_id)
        );`,

    CREATE_TEAM_USER_TABLE_V1_QUERY: `
        CREATE TABLE IF NOT EXISTS public.user_v1
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            user_id character varying(50) NOT NULL,
            user_name character varying(200) NOT NULL,
            -- label is an optional label for the user to be used
            -- instead of the slack name. Not currently implemented.
            label character varying(200),
            team_id bigint NOT NULL,
            abstract_user_id bigint NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT user_v1_user_fk_team FOREIGN KEY(team_id) REFERENCES public.team_v1(id),
            CONSTRAINT user_v1_user_fk_abstract_user FOREIGN KEY(abstract_user_id) REFERENCES public.abstract_user_v1(id),
            CONSTRAINT user_v1_user_id_team_id_unique UNIQUE (user_id, team_id)
        );
        CREATE INDEX user_v1_idx_user_id_team_id ON public.user_v1(user_id, team_id);
        `,

    // This includes a `drink` column but it defaults
    // to coffee and right now there is no way to log
    // anything but a coffee.
    // That's not necessarily because coffee is the superior
    // drink, Jon. That's not what I'm saying.
    CREATE_ABSTRACT_USER_DRINK_TABLE_V1_QUERY: `
        CREATE TABLE IF NOT EXISTS public.drink_v1
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            abstract_user_id bigint NOT NULL,
            -- having both user_id and abstract_user_id is kind of
            -- redundant, but I wasn't sure if it would be desirable
            -- to link drinks back to the specific team at some point
            user_id bigint NOT NULL,
            drink character varying(20) DEFAULT 'coffee',
            PRIMARY KEY (id),
            CONSTRAINT coffee_v1_user_fk_abstract_user FOREIGN KEY(abstract_user_id) REFERENCES public.abstract_user_v1(id),
            CONSTRAINT coffee_v1_user_fk_user FOREIGN KEY(user_id) REFERENCES public.user_v1(id)
        );
        CREATE INDEX coffee_v1_idx_created_at ON public.drink_v1(created_at);
        CREATE INDEX coffee_v1_idx_abstract_user_id ON public.drink_v1(abstract_user_id);
        `,

    CREATE_MIGRATION_TABLE_QUERY: `
        CREATE TABLE IF NOT EXISTS public.migrations
        (
            id int NOT NULL,
            run_at timestamp with time zone NOT NULL,
            PRIMARY KEY(id)
        );`,

    GET_MIGRATION_LEVEL: "SELECT MAX(id) migration_level FROM public.migrations;",

    INSERT_ABSTRACT_USER_V1_QUERY: "INSERT INTO public.abstract_user_v1 (created_at) VALUES ($1) RETURNING id;",
    INSERT_USER_V1_QUERY: `
        INSERT INTO public.user_v1 (created_at, user_id, user_name, team_id, abstract_user_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING id;
        `,

    // Migration V1 functions
    MIGRATION_V1_GET_DISTINCT_USERS_QUERY: "SELECT DISTINCT user_id, user_name FROM public.coffee;",
    MIGRATION_V1_COPY_DRINKS: `
        INSERT INTO public.drink_v1 (created_at, abstract_user_id, user_id)
        SELECT c.created_at, u1.abstract_user_id, u1.id
        FROM public.coffee c
        INNER JOIN public.user_v1 u1 ON u1.user_id = c.user_id
        `,

    MIGRATION_V1_SET_MIGRATION_LEVEL: "INSERT INTO public.migrations (id, run_at) VALUES ($1, $2);",

    GET_ABSTRACT_USER_GIVEN_USER_ID_TEAM_ID_QUERY: `
        SELECT au1.id
        FROM public.user_v1 u1
        INNER JOIN public.abstract_user_v1 au1 ON u1.abstract_user_id = au1.id
        WHERE u1.user_id = $1 AND u1.team_id = $2
    `,

    INSERT_OR_GET_TEAM_V1_QUERY: `
        WITH insert_attempt AS (
            INSERT INTO public.team_v1 (created_at, team_id, team_domain)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            RETURNING id
        )
        SELECT id FROM insert_attempt
        UNION
        SELECT id FROM public.team_v1 WHERE team_id = $2
    `,



    /**
    Design thoughts:
    - if I link drinks -> user -> abstract user, then finding all drinks for user
    means 'find user, then find abstract id, then find all other users with same abstract id,
    the get all drinks for them`.
    If using the abstract user id:
    SELECT u1.user_name, count(*)
    FROM user_v1 u1
    INNER JOIN drink_v1 d1 ON d1.abstract_user_id = u1.abstract_user_id
    INNER JOIN team_v1 t1 ON t1.id = u1.team_id
    WHERE t1.team_id = 'value from slack'
    */



    // CREATE_DATABASE_QUERY : "CREATE DATABASE drinks ENCODING = 'UTF8'",
    // CHECK_IF_DATABASE_EXISTS_QUERY : "SELECT datname FROM pg_catalog.pg_database WHERE datname = drinks;"
    CREATE_BACKUP_TABLE_QUERY: `
        CREATE TABLE IF NOT EXISTS public.backups
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            backup_until timestamp with time zone NOT NULL,
            successful BOOLEAN NOT NULL,
            message TEXT,
            PRIMARY KEY (id)
        );`,
    GET_LAST_SUCCESSFUL_BACKUP_DATETIME_QUERY: "SELECT backup_until FROM public.backups WHERE successful = TRUE ORDER BY backup_until DESC LIMIT 1",
    CREATE_BACKUP_ROW_QUERY: "INSERT INTO public.backups (created_at, backup_until, successful, message) VALUES ($1, $2, $3, $4)",

    CREATE_DRINK_TABLE_QUERY: `
        CREATE TABLE IF NOT EXISTS public.coffee
        (
            id bigserial NOT NULL,
            user_id character varying(50) NOT NULL,
            user_name character varying(200),
            created_at timestamp with time zone NOT NULL,
            PRIMARY KEY (id)
        );`,

    ADD_DRINK_QUERY: "INSERT INTO coffee (user_id, user_name, created_at) VALUES($1, $2, $3);",
    COUNT_ALL_DRINKS_QUERY: "SELECT COUNT(*) FROM coffee WHERE created_at > $1 AND created_at < $2;",
    COUNT_USER_DRINKS_QUERY: "SELECT COUNT(*) FROM coffee WHERE user_id = $1 AND created_at > $2 AND created_at < $3;",
    COUNT_ALL_DRINKS_EVER_QUERY: "SELECT COUNT(*) FROM coffee;",
    AVERAGE_USER_DRINKS_EVER_QUERY: `
        SELECT user_name, COUNT(coffees_on_day) AS reporting_days, SUM(coffees_on_day) AS total_coffees, AVG(coffees_on_day) AS avg_coffees_per_day, STDDEV(coffees_on_day) AS stddev_coffees_per_day
        FROM (
        SELECT user_name, COUNT(*) AS coffees_on_day
        FROM coffee
        GROUP BY user_name, date(created_at AT TIME ZONE 'Australia/Melbourne')
        ) AS coffees_per_day
        GROUP BY user_name
        ORDER BY avg_coffees_per_day DESC;`,
    TALLY_ALL_DRINKS_QUERY: "SELECT user_name, COUNT(*) AS drink_count FROM coffee WHERE created_at > $1 AND created_at < $2 GROUP BY user_name ORDER BY drink_count DESC;",
    DELETE_N_MOST_RECENT_DRINKS_FOR_USER_QUERY: "DELETE FROM coffee WHERE id IN (SELECT id FROM coffee WHERE user_id = $1 AND created_at > $2 AND created_at < $3 ORDER BY id DESC LIMIT $4);",
    ALL_DRINKS_SINCE_DATETIME_QUERY: "SELECT id, user_id, user_name, created_at FROM coffee WHERE created_at > $1;",
    ALL_DRINKS_QUERY: "SELECT id, user_id, user_name, created_at FROM coffee;",
    GET_USER_V1_QUERY: `SELECT abstract_user_id FROM user_v1 WHERE user_id = $1 AND team_id = $2;`,
    INSERT_OR_GET_USER_V1_QUERY: `
    WITH insert_attempt AS (
      INSERT INTO user_v1 (created_at, user_id, user_name, team_id, )
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT id FROM insert_attempt
    UNION
    SELECT id FROM team_v1 WHERE team_id = $2;
    `,
}