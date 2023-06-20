module.exports = {
    // CREATE_DATABASE_QUERY : "CREATE DATABASE drinks ENCODING = 'UTF8'",
    // CHECK_IF_DATABASE_EXISTS_QUERY : "SELECT datname FROM pg_catalog.pg_database WHERE datname = drinks;"
    BEGIN: 'BEGIN;',
    ROLLBACK: 'ROLLBACK',
    COMMIT: 'COMMIT',
    CREATE_ABSTRACT_USER_TABLE_V2_QUERY: `
        CREATE TABLE IF NOT EXISTS public.abstract_user_v2
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            PRIMARY KEY (id)
        );`,

    CREATE_TEAM_TABLE_V2_QUERY: `
        CREATE TABLE IF NOT EXISTS public.team_v2
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
            CONSTRAINT team_v2_team_id_unique UNIQUE (team_id)
        );`,

    CREATE_USER_TABLE_V2_QUERY: `
        CREATE TABLE IF NOT EXISTS public.user_v2
        (
            id bigserial NOT NULL,
            created_at timestamp with time zone NOT NULL,
            user_id character varying(50) NOT NULL,
            user_name character varying(200) NOT NULL,
            -- label is an optional label for the user to be used
            -- instead of the slack name. Not currently implemented.
            label character varying(200),
            is_admin bool NOT NULL DEFAULT FALSE,
            team_id bigint NOT NULL,
            abstract_user_id bigint NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT user_v2_user_fk_team FOREIGN KEY(team_id) REFERENCES public.team_v2(id),
            CONSTRAINT user_v2_user_fk_abstract_user FOREIGN KEY(abstract_user_id) REFERENCES public.abstract_user_v2(id),
            CONSTRAINT user_v2_team_id_user_id_unique UNIQUE (team_id, user_id)
        );
        CREATE INDEX user_v2_idx_user_id_team_id ON public.user_v2(user_id, team_id);
        `,

    // This includes a `drink` column but it defaults
    // to coffee and right now there is no way to log
    // anything but a coffee.
    // That's not necessarily because coffee is the superior
    // drink, Jon. That's not what I'm saying.
    CREATE_DRINK_TABLE_V2_QUERY: `
        CREATE TABLE IF NOT EXISTS public.drink_v2
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
            CONSTRAINT drink_v2_user_fk_abstract_user FOREIGN KEY(abstract_user_id) REFERENCES public.abstract_user_v2(id),
            CONSTRAINT drink_v2_user_fk_user FOREIGN KEY(user_id) REFERENCES public.user_v2(id)
        );
        CREATE INDEX drink_v2_idx_created_at ON public.drink_v2(created_at);
        CREATE INDEX drink_v2_idx_abstract_user_id ON public.drink_v2(abstract_user_id);
        `,

    CREATE_LINK_WORDS_TABLE_V2_QUERY: `
        CREATE TABLE IF NOT EXISTS public.link_words_V2
        (
            abstract_user_id bigint NOT NULL,
            words character varying(200),
            created_at timestamp with time zone NOT NULL,
            PRIMARY KEY (abstract_user_id),
            CONSTRAINT link_words_v2_abstract_user_fk_abstract_user FOREIGN KEY(abstract_user_id) REFERENCES public.abstract_user_v2(id)
        );
        CREATE INDEX link_words_v2_idx_words ON public.link_words_v2(words);
        `,



    CREATE_MIGRATION_TABLE_VX_QUERY: `
        CREATE TABLE IF NOT EXISTS public.migrations
        (
            id int NOT NULL,
            run_at timestamp with time zone NOT NULL,
            PRIMARY KEY(id)
        );`,

    GET_MIGRATION_VX_LEVEL: "SELECT MAX(id) migration_level FROM public.migrations;",

    INSERT_ABSTRACT_USER_V2_QUERY: "INSERT INTO public.abstract_user_v2 (created_at) VALUES ($1) RETURNING id;",
    INSERT_USER_V2_QUERY: `
        INSERT INTO public.user_v2 (created_at, user_id, user_name, team_id, abstract_user_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING id;
        `,

    // Migration V2 functions
    MIGRATION_V2_GET_DISTINCT_USERS_QUERY: "SELECT DISTINCT user_id, user_name FROM public.coffee;",
    MIGRATION_V2_COPY_DRINKS: `
        INSERT INTO public.drink_v2 (created_at, abstract_user_id, user_id)
        SELECT c.created_at, u1.abstract_user_id, u1.id
        FROM public.coffee c
        INNER JOIN public.user_v2 u1 ON u1.user_id = c.user_id
        `,

    MIGRATION_V2_SET_MIGRATION_LEVEL: "INSERT INTO public.migrations (id, run_at) VALUES ($1, $2);",

    INSERT_OR_GET_TEAM_V2_QUERY: `
        WITH insert_attempt AS (
            INSERT INTO public.team_v2 (created_at, team_id, team_domain)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            RETURNING id, label
        )
        SELECT id, label FROM insert_attempt
        UNION
        SELECT id, label FROM public.team_v2 WHERE team_id = $2
    `,

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

    CREATE_DRINK_TABLE_V1_QUERY: `
        CREATE TABLE IF NOT EXISTS public.coffee
        (
            id bigserial NOT NULL,
            user_id character varying(50) NOT NULL,
            user_name character varying(200),
            created_at timestamp with time zone NOT NULL,
            PRIMARY KEY (id)
        );`,

    ADD_DRINK_V2_QUERY: `
        INSERT INTO public.drink_v2 (abstract_user_id, user_id, created_at)
        VALUES ($1, $2, $3);
        `,
    COUNT_ALL_DRINKS_V2_QUERY: `
        SELECT COUNT(*)
        FROM public.user_v2 u1
        INNER JOIN public.drink_v2 d1 ON d1.abstract_user_id = u1.abstract_user_id
        WHERE u1.team_id = $3 AND d1.created_at > $1 AND d1.created_at < $2;
    `,
    COUNT_USER_DRINKS_V2_QUERY: `
        SELECT COUNT(*)
        FROM public.drink_v2
        WHERE abstract_user_id = $1 AND created_at > $2 AND created_at < $3;
    `,
    COUNT_ALL_DRINKS_EVER_V2_QUERY: `
        SELECT COUNT(*)
        FROM public.drink_v2 d2
        INNER JOIN public.user_v2 u2 ON u2.abstract_user_id = d2.abstract_user_id
        WHERE u2.team_id = $1;
    `,
    AVERAGE_USER_DRINKS_EVER_V2_QUERY: `
        SELECT
            user_name,
            COUNT(coffees_on_day) AS reporting_days,
            SUM(coffees_on_day) AS total_coffees,
            AVG(coffees_on_day) AS avg_coffees_per_day,
            STDDEV(coffees_on_day) AS stddev_coffees_per_day
        FROM (
            SELECT u2.user_name, COUNT(*) AS coffees_on_day
            FROM public.drink_v2 d2
            INNER JOIN public.user_v2 u2 ON u2.abstract_user_id = d2.abstract_user_id
            WHERE u2.team_id = $1
            GROUP BY u2.user_name, date(d2.created_at AT TIME ZONE 'Australia/Melbourne')
        ) AS coffees_per_day
        GROUP BY user_name
        ORDER BY avg_coffees_per_day DESC;
    `,
    TALLY_ALL_DRINKS_V2_QUERY: `
        SELECT u1.user_name, COUNT(*) AS drink_count
        FROM public.user_v2 u1
        INNER JOIN public.drink_v2 d1 ON d1.abstract_user_id = u1.abstract_user_id
        WHERE d1.created_at > $1 AND d1.created_at < $2 AND u1.team_id = $3
        GROUP BY u1.user_name
        ORDER BY drink_count DESC;
    `,
    DELETE_N_MOST_RECENT_DRINKS_FOR_USER_V2_QUERY: `
        DELETE FROM drink_v2
        WHERE id IN (
            SELECT d1.id
            FROM public.drink_v2 d1
            WHERE d1.abstract_user_id = $1 AND created_at > $2 AND created_at < $3
            ORDER BY d1.id DESC
            LIMIT $4
        );
    `,

    GET_USER_V2_QUERY: `
        SELECT id, abstract_user_id, is_admin, user_name
        FROM public.user_v2
        WHERE user_id = $1 AND team_id = $2;
    `,
    INSERT_OR_GET_USER_V2_QUERY: `
        WITH insert_attempt AS (
            INSERT INTO public.user_v2 (created_at, user_id, user_name, abstract_user_id, team_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
            RETURNING abstract_user_id, id, is_admin
        )
        SELECT abstract_user_id, id, is_admin
        FROM insert_attempt
        UNION
        SELECT abstract_user_id, id, is_admin
        FROM public.user_v2
        WHERE user_id = $2 AND team_id = $5;
    `,

    UPDATE_USER_NAME_V2_QUERY: `
        UPDATE public.user_v2
        SET user_name = $2
        WHERE id = $1;
    `,

    INSERT_LINK_WORDS_V2_QUERY: `
        INSERT INTO public.link_words_v2 (abstract_user_id, words, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(abstract_user_id) DO UPDATE SET words = $2, created_at = $3;
    `,
    GET_ABSTRACT_USER_FOR_LINK_WORD_V2_QUERY: `
        SELECT abstract_user_id
        FROM public.link_words_v2
        WHERE words = $1 AND created_at > $2;
    `,
    DELETE_LINK_WORD_V2_QUERY: `
        DELETE FROM public.link_words_v2
        WHERE words = $1;
    `,
    UPDATE_ABSTRACT_USER_FOR_DRINKS_V2_QUERY: `
        UPDATE public.drink_v2
        SET abstract_user_id = $2
        WHERE abstract_user_id = $1;
    `,
    UPDATE_ABSTRACT_USER_FOR_USER_V2_QUERY: `
        UPDATE public.user_v2
        SET abstract_user_id = $2
        WHERE abstract_user_id = $1;
    `,

    BACKUP_ABSTRACT_USER_SINCE_DATE_V2_QUERY: `
        SELECT * FROM public.abstract_user_v2 WHERE created_at > $1;
    `,
    BACKUP_ABSTRACT_USER_ALL_V2_QUERY: `
        SELECT * FROM public.abstract_user_v2;
    `,
    BACKUP_TEAM_SINCE_DATE_V2_QUERY: `
        SELECT * FROM public.team_v2 WHERE created_at > $1;
    `,
    BACKUP_TEAM_ALL_V2_QUERY: `
        SELECT * FROM public.team_v2;
    `,
    BACKUP_USER_SINCE_DATE_V2_QUERY: `
        SELECT * FROM public.user_v2 WHERE created_at > $1;
    `,
    BACKUP_USER_ALL_V2_QUERY: `
        SELECT * FROM public.user_v2;
    `,
    BACKUP_DRINK_SINCE_DATE_V2_QUERY: `
        SELECT * FROM public.drink_v2 WHERE created_at > $1;
    `,
    BACKUP_DRINK_ALL_V2_QUERY: `
        SELECT * FROM public.drink_v2;
    `,

    MAKE_ADMIN_IF_NOT_ALREADY_V2_QUERY: `
        UPDATE public.user_v2
        SET is_admin = TRUE
        WHERE id = $1 AND is_admin = FALSE
        RETURNING id, is_admin;
    `,

    SET_TEAM_LABEL_V2: `
        UPDATE public.team_v2
        SET label = $2
        WHERE id = $1;
    `
}