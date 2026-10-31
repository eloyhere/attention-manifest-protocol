#!/usr/bin/env node
/**
 * SQL outline boundary checks.
 *
 * The fixtures live in a private temporary directory, are driven through a
 * registry that contains exactly `SqlStrategy`, and are removed after the run.
 * Two entry points are exercised on purpose:
 *
 * - `OutlineRegistry.build` proves selection, charset handling, anchor
 *   construction, UTF-8 byte ranges, node budgets and frozen results;
 * - `parseSql` proves parser-local behaviour (dialect detection, explicit
 *   dialect override, masking) without a file round trip.
 *
 * Every assertion is a boundary assertion: it describes what the scanner
 * promises about a construct, a range or a failure mode, not what a full SQL
 * grammar would do. The mapping and the known limits are documented in
 * `docs/testing/languages/sqlReport.md`.
 *
 * Run with: `node tools/sqlOutlineCheck.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { ByteLineIndex } from "../src/syntax/byteIndex.ts";
import { LineIndex } from "../src/syntax/charset.ts";
import { OutlineRegistry, outlineNodeFingerprint } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import {
    DefaultSqlDialectRegistry,
    SqlDialectRegistry,
    SqlStrategy,
    detectSqlDialect,
    parseSql,
} from "../src/outline/sqlOutline.ts";
import type { SqlDialect } from "../src/outline/sqlOutline.ts";
import type { OutlineNode, OutlineRange, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";
import { rawTextDigest } from "../src/fingerprint/raw.ts";

/**
 * Private fixture root; the sandbox has exactly one writable session root.
 */
const Root: string = mkdtempSync(join(tmpdir(), "amp-sql-outline-"));
const RootSpec: SessionRoot = { id: "root.sql", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);
const Registry: OutlineRegistry = new OutlineRegistry([SqlStrategy]);

after((): void => {
    rmSync(Root, { recursive: true, force: true });
});

/**
 * Write one fixture, creating intermediate directories.
 */
const fixture: (relative: string, content: string | Uint8Array) => void = (relative: string, content: string | Uint8Array): void => {
    const absolute: string = join(Root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
};

/**
 * Run the SQL-only registry against the fixture sandbox.
 */
const outline: (path: string, options?: { readonly maxNodes?: number; readonly maxDepth?: number; }) => OutlineResult = (
    path: string,
    options: { readonly maxNodes?: number; readonly maxDepth?: number; } = {},
): OutlineResult => Registry.build(Sandbox, path, options);

/**
 * Parse a string directly, bypassing file selection.
 */
const direct: (text: string, dialect?: SqlDialect) => OutlineNode[] = (text: string, dialect?: SqlDialect): OutlineNode[] =>
    parseSql({ path: "query.sql", text, lineIndex: new LineIndex(text) }, dialect);

/**
 * Preorder flattening of an outline tree.
 */
const flatten: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] => {
    const result: OutlineNode[] = [];
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: OutlineNode = nodes[index];
        result.push(node);
        const children: OutlineNode[] = flatten(node.children);
        for (let childIndex: number = 0; childIndex < children.length; childIndex += 1) {
            result.push(children[childIndex]);
        }
    }
    return result;
};

/**
 * First node with one label, depth first.
 */
const findNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined = (
    nodes: readonly OutlineNode[],
    label: string,
): OutlineNode | undefined => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: OutlineNode = nodes[index];
        if (node.label === label) {
            return node;
        }
        const nested: OutlineNode | undefined = findNode(node.children, label);
        if (nested !== (void 0)) {
            return nested;
        }
    }
    return undefined;
};

/**
 * First node with one label; fails the test when absent.
 */
const requireNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode = (nodes: readonly OutlineNode[], label: string): OutlineNode => {
    const node: OutlineNode | undefined = findNode(nodes, label);
    assert.ok(node !== (void 0), `missing outline node: ${label}`);
    return node!;
};

/**
 * Labels of a node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

/**
 * 1-based number of the first line containing one substring.
 */
const lineWith: (text: string, needle: string) => number = (text: string, needle: string): number => {
    const lines: string[] = text.split("\n");
    for (let index: number = 0; index < lines.length; index += 1) {
        if (lines[index].includes(needle)) {
            return index + 1;
        }
    }
    return 0;
};

/**
 * 1-based numbers of every line containing one substring.
 */
const linesWith: (text: string, needle: string) => number[] = (text: string, needle: string): number[] => {
    const found: number[] = [];
    const lines: string[] = text.split("\n");
    for (let index: number = 0; index < lines.length; index += 1) {
        if (lines[index].includes(needle)) {
            found.push(index + 1);
        }
    }
    return found;
};

/**
 * Assert one node's line and UTF-8 byte range against `ByteLineIndex`.
 */
const assertNodeRange: (node: OutlineNode, text: string, startLine: number, endLine: number, bomBytes?: number) => void = (
    node: OutlineNode,
    text: string,
    startLine: number,
    endLine: number,
    bomBytes: number = 0,
): void => {
    const index: ByteLineIndex = new ByteLineIndex(text, bomBytes);
    const expected: OutlineRange = index.range(startLine, endLine);
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    assert.equal(node.range.startByte, expected.startByte);
    assert.equal(node.range.endByte, expected.endByte);
};

/**
 * Show one node's shape in a failure message.
 */
const describeNode: (node: OutlineNode) => string = (node: OutlineNode): string =>
    `${node.type}:${node.label}[${Number(node.range.startLine)}-${Number(node.range.endLine)}] ${node.detail ?? ""}`;

/**
 * MySQL fixture: two tables, a hash comment, a block comment, a string that
 * looks like DDL, indexes, a view, a trigger and ignored DML.
 */
const MySqlText: string = [
    "-- MySQL 8 dump",
    "# a hash comment with a fake CREATE TABLE ghost_hash (id INT);",
    "/* block comment",
    "   CREATE TABLE ghost_block (id INT);",
    "*/",
    "CREATE TABLE `users` (",
    "    `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,",
    "    `email` VARCHAR(255) NOT NULL UNIQUE,",
    "    `team_id` INT UNSIGNED,",
    "    `nickname` VARCHAR(64) DEFAULT 'CREATE TABLE ghost_string (id INT)',",
    "    PRIMARY KEY (`id`),",
    "    CONSTRAINT `fk_users_team` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`)",
    ") ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4;",
    "",
    "CREATE TABLE `teams` (",
    "    `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,",
    "    `name` VARCHAR(128) NOT NULL,",
    "    PRIMARY KEY (`id`)",
    ") ENGINE=InnoDB;",
    "",
    "CREATE INDEX `idx_users_email` ON `users` (`email`);",
    "CREATE UNIQUE INDEX `uq_teams_name` ON `teams` (`name`);",
    "CREATE VIEW `active_users` AS SELECT `id`, `email` FROM `users`;",
    "CREATE TRIGGER `trg_users_ai` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.`id` = 1;",
    "INSERT INTO `users` (`email`) VALUES ('x@example.com');",
    "UPDATE `users` SET `email` = 'y@example.com';",
    "DELETE FROM `users`;",
].join("\n");

/**
 * SQLite fixture: AUTOINCREMENT, WITHOUT ROWID, a column-level reference and a
 * trigger body that spans several `;`-terminated statements.
 */
const SqliteText: string = [
    "PRAGMA foreign_keys = ON;",
    "",
    "CREATE TABLE IF NOT EXISTS accounts (",
    "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "    email TEXT NOT NULL UNIQUE,",
    "    owner_id INTEGER REFERENCES owners(id),",
    "    created_at TEXT DEFAULT 'CREATE TABLE ghost_sqlite (id INT)'",
    ");",
    "",
    "CREATE TABLE owners (",
    "    id INTEGER PRIMARY KEY,",
    "    name TEXT NOT NULL",
    ") WITHOUT ROWID;",
    "",
    "CREATE INDEX idx_accounts_email ON accounts (email);",
    "CREATE VIEW account_emails AS SELECT email FROM accounts;",
    "",
    "CREATE TRIGGER trg_accounts_ai AFTER INSERT ON accounts",
    "BEGIN",
    "    UPDATE accounts SET email = NEW.email WHERE id = NEW.id;",
    "END;",
    "",
    "INSERT INTO accounts (email) VALUES ('CREATE TABLE ghost_insert (id INT)');",
].join("\n");

/**
 * PostgreSQL fixture: schema-qualified names, serial columns, a dollar-quoted
 * routine, a `::` cast inside the body and `RETURNING` DML.
 */
const PostgresText: string = [
    "-- PostgreSQL schema",
    "CREATE TABLE public.teams (",
    "    id BIGSERIAL PRIMARY KEY,",
    "    name TEXT NOT NULL UNIQUE",
    ");",
    "",
    "CREATE TABLE public.users (",
    "    id BIGSERIAL PRIMARY KEY,",
    "    team_id BIGINT REFERENCES public.teams (id) ON DELETE CASCADE,",
    "    email TEXT NOT NULL,",
    "    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "    CONSTRAINT users_email_key UNIQUE (email)",
    ");",
    "",
    "CREATE UNIQUE INDEX users_email_idx ON public.users (email);",
    "CREATE INDEX users_team_idx ON public.users USING btree (team_id);",
    "",
    "CREATE OR REPLACE VIEW public.active_users AS",
    "    SELECT id, email FROM public.users WHERE email IS NOT NULL;",
    "",
    "CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $$",
    "BEGIN",
    "    -- CREATE TABLE ghost_dollar (id INT);",
    "    NEW.created_at := now()::timestamptz;",
    "    RETURN NEW;",
    "END;",
    "$$ LANGUAGE plpgsql;",
    "",
    "CREATE TRIGGER users_touch BEFORE UPDATE ON public.users",
    "    FOR EACH ROW EXECUTE FUNCTION public.touch_updated();",
    "",
    "INSERT INTO public.users (email) VALUES ('CREATE TABLE ghost_pg (id INT)') RETURNING id;",
    "UPDATE public.users SET email = 'x@example.com' RETURNING id;",
    "DELETE FROM public.users WHERE id = 1 RETURNING id;",
].join("\n");

/**
 * SQL Server fixture: `GO` batches, `IDENTITY`, `NVARCHAR`, bracketed
 * identifiers, a constraint and a procedure body that spans `;` statements.
 */
const SqlServerText: string = [
    "-- SQL Server schema",
    "CREATE TABLE dbo.Users (",
    "    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,",
    "    Email NVARCHAR(256) NOT NULL,",
    "    [Display Name] NVARCHAR(128) NULL,",
    "    TeamId INT NULL,",
    "    CONSTRAINT FK_Users_Teams FOREIGN KEY (TeamId) REFERENCES dbo.Teams (Id)",
    ");",
    "GO",
    "",
    "CREATE TABLE dbo.Teams (",
    "    Id INT IDENTITY(1,1) NOT NULL,",
    "    Name NVARCHAR(128) NOT NULL,",
    "    CONSTRAINT PK_Teams PRIMARY KEY (Id)",
    ");",
    "GO",
    "",
    "CREATE INDEX IX_Users_Email ON dbo.Users (Email);",
    "GO",
    "",
    "CREATE OR ALTER PROCEDURE dbo.usp_AddUser",
    "    @Email NVARCHAR(256)",
    "AS",
    "BEGIN",
    "    SET NOCOUNT ON;",
    "    INSERT INTO dbo.Users (Email) VALUES (@Email);",
    "END;",
    "GO",
    "",
    "CREATE VIEW dbo.vw_Users AS SELECT Id, Email FROM dbo.Users;",
    "GO",
    "",
    "INSERT INTO dbo.Users (Email) VALUES (N'CREATE TABLE ghost_tsql (Id INT)');",
    "GO",
].join("\n");

/**
 * Oracle fixture: `NUMBER`/`VARCHAR2`, a sequence, two PL/SQL blocks terminated
 * by `/`, `DUAL`, `ROWNUM`, a view, an index and ignored DML.
 */
const OracleText: string = [
    "-- Oracle schema",
    "CREATE TABLE app.customers (",
    "    customer_id NUMBER(10) NOT NULL,",
    "    email VARCHAR2(320) NOT NULL,",
    "    created_at DATE DEFAULT SYSDATE,",
    "    CONSTRAINT pk_customers PRIMARY KEY (customer_id),",
    "    CONSTRAINT uq_customers_email UNIQUE (email)",
    ");",
    "",
    "CREATE SEQUENCE seq_customers START WITH 1 INCREMENT BY 1 NOCACHE;",
    "",
    "CREATE OR REPLACE PROCEDURE app.add_customer (",
    "    p_email IN VARCHAR2",
    ") AS",
    "    v_id NUMBER;",
    "BEGIN",
    "    SELECT seq_customers.NEXTVAL INTO v_id FROM dual;",
    "    -- CREATE TABLE ghost_oracle (id NUMBER);",
    "    INSERT INTO app.customers (customer_id, email) VALUES (v_id, p_email);",
    "END;",
    "/",
    "",
    "CREATE OR REPLACE FUNCTION app.customer_count RETURN NUMBER AS",
    "    v_count NUMBER;",
    "BEGIN",
    "    SELECT COUNT(*) INTO v_count FROM app.customers;",
    "    RETURN v_count;",
    "END;",
    "/",
    "",
    "CREATE INDEX ix_customers_email ON app.customers (email);",
    "",
    "CREATE OR REPLACE VIEW app.v_customers AS",
    "    SELECT customer_id, email FROM app.customers WHERE ROWNUM <= 10;",
    "",
    "INSERT INTO app.customers (customer_id, email) VALUES (seq_customers.NEXTVAL, 'CREATE TABLE ghost_oracle_string (id NUMBER)');",
    "COMMIT;",
].join("\n");

/**
 * MySQL fixture with the client-side `DELIMITER $$` directive.
 */
const DelimiterText: string = [
    "-- MySQL routine with a custom delimiter",
    "CREATE TABLE accounts (",
    "    id INT AUTO_INCREMENT PRIMARY KEY,",
    "    email VARCHAR(255) NOT NULL",
    ") ENGINE=InnoDB;",
    "",
    "DELIMITER $$",
    "CREATE PROCEDURE add_account(IN p_email VARCHAR(255))",
    "BEGIN",
    "    INSERT INTO accounts (email) VALUES (p_email);",
    "    UPDATE counters SET total = total + 1;",
    "END$$",
    "DELIMITER ;",
    "",
    "INSERT INTO accounts (email) VALUES ('CREATE TABLE ghost_delimiter (id INT)');",
].join("\n");

test("the SQL strategy is tagged sql/data and only matches .sql files", (): void => {
    assert.equal(SqlStrategy.id, "sql");
    assert.equal(SqlStrategy.category, "data");
    assert.equal(SqlStrategy.language, "sql");
    assert.equal(SqlStrategy.matches({ path: "db/schema.sql", name: "schema.sql", head: "" }), true);
    assert.equal(SqlStrategy.matches({ path: "db/schema.SQL", name: "schema.SQL", head: "" }), true);
    assert.equal(SqlStrategy.matches({ path: "db/schema.txt", name: "schema.txt", head: "" }), false);
    assert.equal(SqlStrategy.matches({ path: "db/package.json", name: "package.json", head: "" }), false);
    const registry: OutlineRegistry = new OutlineRegistry([SqlStrategy]);
    assert.equal(registry.select({ path: "db/schema.sql", name: "schema.sql", head: "" }), SqlStrategy);
    assert.equal(registry.select({ path: "db/schema.txt", name: "schema.txt", head: "" }), undefined);
    assert.deepEqual(
        registry.list().map((strategy: { readonly id: string; }): string => strategy.id),
        ["sql"],
    );
});

test("dialect detection scores all five built-in dialects and falls back to PostgreSQL", (): void => {
    assert.equal(detectSqlDialect(MySqlText), "mysql");
    assert.equal(detectSqlDialect(SqliteText), "sqlite");
    assert.equal(detectSqlDialect(PostgresText), "postgresql");
    assert.equal(detectSqlDialect(SqlServerText), "sqlserver");
    assert.equal(detectSqlDialect(OracleText), "oracle");
    const scores: ReadonlyMap<SqlDialect, number> = DefaultSqlDialectRegistry.scores(MySqlText);
    assert.ok((scores.get("mysql") ?? 0) > (scores.get("sqlite") ?? 0));
    assert.ok((scores.get("mysql") ?? 0) > (scores.get("oracle") ?? 0));
    assert.equal(DefaultSqlDialectRegistry.detect("CREATE TABLE plain_table (id INT);"), "postgresql");
    assert.equal(DefaultSqlDialectRegistry.detect(""), "postgresql");
    assert.deepEqual(DefaultSqlDialectRegistry.dialects(), ["mysql", "sqlite", "postgresql", "sqlserver", "oracle"]);
    assert.deepEqual(
        DefaultSqlDialectRegistry.list().map((definition: { readonly label: string; }): string => definition.label),
        ["MySQL", "SQLite", "PostgreSQL", "SQL Server", "Oracle"],
    );
});

test("the dialect registry is extensible and rejects duplicate or invalid definitions", (): void => {
    const registry: SqlDialectRegistry = new SqlDialectRegistry([{ dialect: "sqlite", label: "SQLite", markers: ["\\bPRAGMA\\b"] }]);
    assert.equal(registry.detect("PRAGMA foreign_keys = ON;"), "sqlite");
    assert.equal(registry.detect("SELECT 1;"), "sqlite");
    assert.throws(
        (): void => registry.register("sqlite", { dialect: "sqlite", label: "SQLite", markers: ["\\bPRAGMA\\b"] }),
        /duplicate SQL dialect/,
    );
    assert.throws(
        (): void => registry.register("mysql", { dialect: "sqlserver", label: "X", markers: ["X"] }),
        /SQL dialect mismatch/,
    );
    assert.throws(
        (): void => registry.register("mysql", { dialect: "mysql", label: "X", markers: [] }),
        /no markers/,
    );
    assert.throws(
        (): void => registry.register("mysql", { dialect: "mysql", label: "X", markers: ["("] }),
        /invalid SQL dialect marker/,
    );
    assert.equal(new SqlDialectRegistry().detect("SELECT 1;"), "postgresql");
});

test("a MySQL dump exposes tables, columns, keys, indexes, views and triggers", (): void => {
    fixture("mysql/schema.sql", MySqlText);
    const result: OutlineResult = outline("mysql/schema.sql");
    assert.equal(result.strategy, "sql");
    assert.equal(result.category, "data");
    assert.equal(result.language, "sql");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    const top: readonly OutlineNode[] = result.nodes[0].children;
    assert.deepEqual(labels(top), ["users", "teams", "idx_users_email", "uq_teams_name", "active_users", "trg_users_ai"]);
    const users: OutlineNode = requireNode(result.nodes, "users");
    assert.equal(users.type, "class");
    assert.equal(users.detail, "mysql:table");
    assert.equal(users.depth, 1);
    assert.equal(users.path, "mysql/schema.sql#users");
    assert.deepEqual(labels(users.children), ["id", "email", "team_id", "nickname", "primary key", "fk_users_team"]);
    assertNodeRange(users, MySqlText, lineWith(MySqlText, "CREATE TABLE `users`"), lineWith(MySqlText, "ENGINE=InnoDB AUTO_INCREMENT=42"));
    const id: OutlineNode = requireNode(users.children, "id");
    assert.equal(id.type, "property");
    assert.match(id.detail ?? "", /^mysql:INT UNSIGNED NOT NULL AUTO_INCREMENT$/);
    const email: OutlineNode = requireNode(users.children, "email");
    assert.deepEqual(labels(email.children), ["unique"]);
    assert.equal(email.children[0].type, "key");
    assert.equal(email.children[0].detail, "mysql:unique");
    const primary: OutlineNode = requireNode(users.children, "primary key");
    assert.equal(primary.type, "key");
    assert.equal(primary.detail, "mysql:primary key");
    const foreign: OutlineNode = requireNode(users.children, "fk_users_team");
    assert.equal(foreign.type, "dependency");
    assert.equal(foreign.detail, "mysql:foreign key -> teams");
    const index: OutlineNode = requireNode(result.nodes, "idx_users_email");
    assert.equal(index.type, "key");
    assert.equal(index.detail, "mysql:index on users");
    const uniqueIndex: OutlineNode = requireNode(result.nodes, "uq_teams_name");
    assert.equal(uniqueIndex.detail, "mysql:unique index on teams");
    const view: OutlineNode = requireNode(result.nodes, "active_users");
    assert.equal(view.type, "type");
    assert.equal(view.detail, "mysql:view");
    const trigger: OutlineNode = requireNode(result.nodes, "trg_users_ai");
    assert.equal(trigger.type, "method");
    assert.equal(trigger.detail, "mysql:trigger on users");
    assert.equal(findNode(result.nodes, "ghost_hash"), undefined);
    assert.equal(findNode(result.nodes, "ghost_block"), undefined);
    assert.equal(findNode(result.nodes, "ghost_string"), undefined);
});

test("a SQLite schema keeps AUTOINCREMENT, WITHOUT ROWID, references and a trigger body", (): void => {
    fixture("sqlite/schema.sql", SqliteText);
    const result: OutlineResult = outline("sqlite/schema.sql");
    assert.equal(result.strategy, "sql");
    assert.deepEqual(labels(result.nodes[0].children), [
        "accounts",
        "owners",
        "idx_accounts_email",
        "account_emails",
        "trg_accounts_ai",
    ]);
    const accounts: OutlineNode = requireNode(result.nodes, "accounts");
    assert.equal(accounts.detail, "sqlite:table");
    assert.deepEqual(accounts.modifiers, ["if not exists"]);
    assert.deepEqual(labels(accounts.children), ["id", "email", "owner_id", "created_at"]);
    const id: OutlineNode = requireNode(accounts.children, "id");
    assert.match(id.detail ?? "", /^sqlite:INTEGER PRIMARY KEY AUTOINCREMENT$/);
    assert.deepEqual(labels(id.children), ["primary key"]);
    const owner: OutlineNode = requireNode(accounts.children, "owner_id");
    assert.deepEqual(labels(owner.children), ["references owners"]);
    assert.equal(owner.children[0].type, "reference");
    assert.equal(owner.children[0].detail, "sqlite:references -> owners");
    const owners: OutlineNode = requireNode(result.nodes, "owners");
    assert.deepEqual(owners.modifiers, ["without rowid"]);
    const trigger: OutlineNode = requireNode(result.nodes, "trg_accounts_ai");
    assert.equal(trigger.type, "method");
    assert.equal(trigger.detail, "sqlite:trigger on accounts");
    assertNodeRange(trigger, SqliteText, lineWith(SqliteText, "CREATE TRIGGER trg_accounts_ai"), lineWith(SqliteText, "END;"));
    assert.equal(findNode(result.nodes, "ghost_sqlite"), undefined);
    assert.equal(findNode(result.nodes, "ghost_insert"), undefined);
});

test("a PostgreSQL schema handles serial columns, a dollar-quoted routine and RETURNING", (): void => {
    fixture("postgresql/schema.sql", PostgresText);
    const result: OutlineResult = outline("postgresql/schema.sql");
    assert.deepEqual(labels(result.nodes[0].children), [
        "public.teams",
        "public.users",
        "users_email_idx",
        "users_team_idx",
        "public.active_users",
        "public.touch_updated",
        "users_touch",
    ]);
    const teams: OutlineNode = requireNode(result.nodes, "public.teams");
    assert.equal(teams.detail, "postgresql:table");
    assert.deepEqual(labels(teams.children), ["id", "name"]);
    assert.deepEqual(labels(requireNode(teams.children, "id").children), ["primary key"]);
    assert.deepEqual(labels(requireNode(teams.children, "name").children), ["unique"]);
    const users: OutlineNode = requireNode(result.nodes, "public.users");
    assert.deepEqual(labels(users.children), ["id", "team_id", "email", "created_at", "users_email_key"]);
    const reference: OutlineNode = requireNode(users.children, "team_id");
    assert.deepEqual(labels(reference.children), ["references public.teams"]);
    assert.equal(reference.children[0].detail, "postgresql:references -> public.teams");
    const uniqueConstraint: OutlineNode = requireNode(users.children, "users_email_key");
    assert.equal(uniqueConstraint.type, "key");
    assert.equal(uniqueConstraint.detail, "postgresql:unique");
    const emailIndex: OutlineNode = requireNode(result.nodes, "users_email_idx");
    assert.equal(emailIndex.detail, "postgresql:unique index on public.users");
    const teamIndex: OutlineNode = requireNode(result.nodes, "users_team_idx");
    assert.equal(teamIndex.detail, "postgresql:index on public.users");
    const view: OutlineNode = requireNode(result.nodes, "public.active_users");
    assert.equal(view.type, "type");
    assert.equal(view.detail, "postgresql:view");
    assert.deepEqual(view.modifiers, ["or replace"]);
    const routine: OutlineNode = requireNode(result.nodes, "public.touch_updated");
    assert.equal(routine.type, "function");
    assert.equal(routine.detail, "postgresql:function");
    assertNodeRange(routine, PostgresText, lineWith(PostgresText, "CREATE OR REPLACE FUNCTION public.touch_updated"), lineWith(PostgresText, "$$ LANGUAGE plpgsql"));
    assert.ok(Number(routine.range.endLine) > Number(routine.range.startLine));
    const trigger: OutlineNode = requireNode(result.nodes, "users_touch");
    assert.equal(trigger.type, "method");
    assert.equal(trigger.detail, "postgresql:trigger on public.users");
    assert.equal(findNode(result.nodes, "ghost_dollar"), undefined);
    assert.equal(findNode(result.nodes, "ghost_pg"), undefined);
});

test("a SQL Server script follows GO batches, bracketed names and merged routine bodies", (): void => {
    fixture("sqlserver/schema.sql", SqlServerText);
    const result: OutlineResult = outline("sqlserver/schema.sql");
    assert.deepEqual(labels(result.nodes[0].children), [
        "dbo.Users",
        "dbo.Teams",
        "IX_Users_Email",
        "dbo.usp_AddUser",
        "dbo.vw_Users",
    ]);
    const users: OutlineNode = requireNode(result.nodes, "dbo.Users");
    assert.equal(users.detail, "sqlserver:table");
    assert.deepEqual(labels(users.children), ["Id", "Email", "Display Name", "TeamId", "FK_Users_Teams"]);
    const id: OutlineNode = requireNode(users.children, "Id");
    assert.match(id.detail ?? "", /^sqlserver:INT IDENTITY\(1,1\) NOT NULL PRIMARY KEY$/);
    assert.deepEqual(labels(id.children), ["primary key"]);
    const displayName: OutlineNode = requireNode(users.children, "Display Name");
    assert.match(displayName.detail ?? "", /^sqlserver:NVARCHAR\(128\) NULL$/);
    const foreign: OutlineNode = requireNode(users.children, "FK_Users_Teams");
    assert.equal(foreign.type, "dependency");
    assert.equal(foreign.detail, "sqlserver:foreign key -> dbo.Teams");
    const teams: OutlineNode = requireNode(result.nodes, "dbo.Teams");
    assert.deepEqual(labels(teams.children), ["Id", "Name", "PK_Teams"]);
    assert.equal(requireNode(teams.children, "PK_Teams").type, "key");
    const index: OutlineNode = requireNode(result.nodes, "IX_Users_Email");
    assert.equal(index.detail, "sqlserver:index on dbo.Users");
    const procedure: OutlineNode = requireNode(result.nodes, "dbo.usp_AddUser");
    assert.equal(procedure.type, "function");
    assert.equal(procedure.detail, "sqlserver:procedure");
    assertNodeRange(procedure, SqlServerText, lineWith(SqlServerText, "CREATE OR ALTER PROCEDURE"), lineWith(SqlServerText, "END;"));
    const view: OutlineNode = requireNode(result.nodes, "dbo.vw_Users");
    assert.equal(view.detail, "sqlserver:view");
    assert.equal(findNode(result.nodes, "ghost_tsql"), undefined);
    assert.equal(findNode(result.nodes, "NOCOUNT"), undefined);
});

test("an Oracle schema handles NUMBER/VARCHAR2, sequences, PL/SQL blocks and the slash terminator", (): void => {
    fixture("oracle/schema.sql", OracleText);
    const result: OutlineResult = outline("oracle/schema.sql");
    assert.deepEqual(labels(result.nodes[0].children), [
        "app.customers",
        "seq_customers",
        "app.add_customer",
        "app.customer_count",
        "ix_customers_email",
        "app.v_customers",
    ]);
    const customers: OutlineNode = requireNode(result.nodes, "app.customers");
    assert.equal(customers.detail, "oracle:table");
    assert.deepEqual(labels(customers.children), [
        "customer_id",
        "email",
        "created_at",
        "pk_customers",
        "uq_customers_email",
    ]);
    assert.match(requireNode(customers.children, "customer_id").detail ?? "", /^oracle:NUMBER\(10\) NOT NULL$/);
    assert.match(requireNode(customers.children, "email").detail ?? "", /^oracle:VARCHAR2\(320\) NOT NULL$/);
    assert.equal(requireNode(customers.children, "pk_customers").detail, "oracle:primary key");
    assert.equal(requireNode(customers.children, "uq_customers_email").detail, "oracle:unique");
    const sequence: OutlineNode = requireNode(result.nodes, "seq_customers");
    assert.equal(sequence.type, "object");
    assert.equal(sequence.detail, "oracle:sequence");
    const procedure: OutlineNode = requireNode(result.nodes, "app.add_customer");
    assert.equal(procedure.type, "function");
    assert.equal(procedure.detail, "oracle:procedure");
    const endLines: number[] = linesWith(OracleText, "END;");
    assert.equal(Number(procedure.range.endLine), endLines[0]);
    assert.ok(Number(procedure.range.startLine) < Number(procedure.range.endLine));
    const routine: OutlineNode = requireNode(result.nodes, "app.customer_count");
    assert.equal(routine.detail, "oracle:function");
    assert.equal(Number(routine.range.endLine), endLines[1]);
    const index: OutlineNode = requireNode(result.nodes, "ix_customers_email");
    assert.equal(index.detail, "oracle:index on app.customers");
    const view: OutlineNode = requireNode(result.nodes, "app.v_customers");
    assert.equal(view.type, "type");
    assert.equal(view.detail, "oracle:view");
    assert.equal(findNode(result.nodes, "ghost_oracle"), undefined);
    assert.equal(findNode(result.nodes, "ghost_oracle_string"), undefined);
    assert.ok(!flatten(result.nodes).some((node: OutlineNode): boolean => node.label.includes("ghost")));
});

test("comments, strings and quoted names cannot create pseudo nodes in any dialect", (): void => {
    const cases: readonly { readonly text: string; readonly ghosts: readonly string[]; }[] = [
        { text: MySqlText, ghosts: ["ghost_hash", "ghost_block", "ghost_string"] },
        { text: SqliteText, ghosts: ["ghost_sqlite", "ghost_insert"] },
        { text: PostgresText, ghosts: ["ghost_dollar", "ghost_pg"] },
        { text: SqlServerText, ghosts: ["ghost_tsql"] },
        { text: OracleText, ghosts: ["ghost_oracle", "ghost_oracle_string"] },
        { text: DelimiterText, ghosts: ["ghost_delimiter"] },
    ];
    for (let index: number = 0; index < cases.length; index += 1) {
        const nodes: OutlineNode[] = direct(cases[index].text);
        assert.ok(nodes.length > 0, `case ${index} produced no structure`);
        for (let ghostIndex: number = 0; ghostIndex < cases[index].ghosts.length; ghostIndex += 1) {
            assert.equal(findNode(nodes, cases[index].ghosts[ghostIndex]), undefined, `pseudo node ${cases[index].ghosts[ghostIndex]} in case ${index}`);
        }
    }
});

test("DELIMITER $$ keeps a MySQL routine body in one statement", (): void => {
    fixture("mysql/delimiter.sql", DelimiterText);
    const result: OutlineResult = outline("mysql/delimiter.sql");
    assert.deepEqual(labels(result.nodes[0].children), ["accounts", "add_account"]);
    const procedure: OutlineNode = requireNode(result.nodes, "add_account");
    assert.equal(procedure.type, "function");
    assert.equal(procedure.detail, "mysql:procedure");
    assertNodeRange(procedure, DelimiterText, lineWith(DelimiterText, "CREATE PROCEDURE add_account"), lineWith(DelimiterText, "END$$"));
    assert.equal(findNode(result.nodes, "counters"), undefined);
    assert.equal(findNode(result.nodes, "ghost_delimiter"), undefined);
    const detection: string = detectSqlDialect(DelimiterText);
    assert.equal(detection, "mysql");
});

test("ALTER TABLE adds columns and constraints as children", (): void => {
    const text: string = [
        "ALTER TABLE users",
        "    ADD COLUMN age INT NOT NULL,",
        "    ADD CONSTRAINT ck_users_age CHECK (age >= 0);",
    ].join("\n");
    fixture("alter.sql", text);
    const result: OutlineResult = outline("alter.sql");
    const top: readonly OutlineNode[] = result.nodes[0].children;
    assert.equal(top.length, 1);
    const altered: OutlineNode = top[0];
    assert.equal(altered.label, "users");
    assert.equal(altered.type, "class");
    assert.equal(altered.detail, "postgresql:alter table");
    assert.deepEqual(labels(altered.children), ["age", "ck_users_age"]);
    assert.equal(altered.children[0].type, "property");
    assert.equal(altered.children[1].type, "key");
    assert.equal(altered.children[1].detail, "postgresql:check");
    assertNodeRange(altered, text, 1, 3);
});

test("INSERT, UPDATE, DELETE, REPLACE, MERGE, TRUNCATE, SELECT and DROP produce no structure", (): void => {
    const dml: string = [
        "INSERT INTO t (id) VALUES (1);",
        "UPDATE t SET id = 2;",
        "DELETE FROM t;",
        "REPLACE INTO t (id) VALUES (3);",
        "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET id = s.id;",
        "TRUNCATE TABLE t;",
        "SELECT 1 FROM dual;",
        "DROP TABLE t;",
    ].join("\n");
    assert.deepEqual(direct(dml), []);
    assert.deepEqual(direct(dml, "oracle"), []);
});

test("schema, database, materialized view, sequence and AS SELECT tables map to existing kinds", (): void => {
    const text: string = [
        "CREATE SCHEMA app;",
        "CREATE DATABASE appdb;",
        "CREATE MATERIALIZED VIEW mv AS SELECT 1;",
        "CREATE SEQUENCE seq_x;",
        "CREATE TABLE audit AS SELECT 1;",
    ].join("\n");
    const nodes: OutlineNode[] = direct(text, "postgresql");
    assert.deepEqual(labels(nodes), ["app", "appdb", "mv", "seq_x", "audit"]);
    assert.deepEqual(
        nodes.map((node: OutlineNode): string => node.type),
        ["namespace", "namespace", "type", "object", "class"],
    );
    assert.equal(nodes[0].detail, "postgresql:schema");
    assert.equal(nodes[1].detail, "postgresql:database");
    assert.equal(nodes[2].detail, "postgresql:materialized view");
    assert.deepEqual(nodes[2].modifiers, ["materialized"]);
    assert.equal(nodes[3].detail, "postgresql:sequence");
    assert.equal(nodes[4].children.length, 0);
});

test("CRLF, UTF-8 BOM and Unicode identifiers keep line numbers, bytes and labels", (): void => {
    const text: string = [
        "PRAGMA foreign_keys = ON;",
        "CREATE TABLE 用户表 (",
        "    编号 INTEGER PRIMARY KEY,",
        "    名称 TEXT NOT NULL",
        ");",
    ].join("\r\n");
    fixture("unicode/schema.sql", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]));
    const result: OutlineResult = outline("unicode/schema.sql");
    assert.equal(result.charset, "utf-8-bom");
    const table: OutlineNode = requireNode(result.nodes, "用户表");
    assert.equal(table.type, "class");
    assert.equal(table.detail, "sqlite:table");
    assert.deepEqual(labels(table.children), ["编号", "名称"]);
    assert.equal(Number(table.range.startLine), 2);
    assert.equal(Number(table.range.endLine), 5);
    assertNodeRange(table, text, 2, 5, 3);
    assert.equal(Number(table.children[0].range.startLine), 3);
    assert.equal(Number(table.children[1].range.startLine), 4);
    assert.ok(!(table.detail ?? "").includes("\r"));
    assert.ok(!(table.children[0].detail ?? "").includes("\r"));
});

test("ranges, paths and fingerprints stay ordered, anchored and bigint", (): void => {
    fixture("ranges.sql", MySqlText);
    const result: OutlineResult = outline("ranges.sql");
    const text: string = MySqlText;
    const index: ByteLineIndex = new ByteLineIndex(text);
    const check: (nodes: readonly OutlineNode[], parent: OutlineNode | undefined) => void = (
        nodes: readonly OutlineNode[],
        parent: OutlineNode | undefined,
    ): void => {
        for (let nodeIndex: number = 0; nodeIndex < nodes.length; nodeIndex += 1) {
            const node: OutlineNode = nodes[nodeIndex];
            assert.equal(typeof(node.range.startByte), "bigint");
            assert.equal(typeof(node.range.endByte), "bigint");
            assert.equal(typeof(node.range.startLine), "bigint");
            assert.equal(typeof(node.range.endLine), "bigint");
            assert.ok(node.range.startByte <= node.range.endByte, describeNode(node));
            assert.ok(node.range.startLine <= node.range.endLine, describeNode(node));
            const expected: OutlineRange = index.range(Number(node.range.startLine), Number(node.range.endLine));
            assert.equal(node.range.startByte, expected.startByte, describeNode(node));
            assert.equal(node.range.endByte, expected.endByte, describeNode(node));
            assert.ok(outlineNodeFingerprint(node).startsWith("sha256:"));
            if (parent === (void 0)) {
                assert.equal(node.depth, 1);
                assert.ok(node.path.startsWith("ranges.sql#"), node.path);
            } else {
                assert.equal(node.depth, parent.depth + 1, describeNode(node));
                assert.ok(node.path.startsWith(`${parent.path}.`), node.path);
                assert.ok(node.range.startByte >= parent.range.startByte, describeNode(node));
                assert.ok(node.range.endByte <= parent.range.endByte, describeNode(node));
                assert.ok(node.range.startLine >= parent.range.startLine, describeNode(node));
            }
            check(node.children, node);
        }
    };
    check(result.nodes[0].children, undefined);
    const users: OutlineNode = requireNode(result.nodes, "users");
    const id: OutlineNode = requireNode(users.children, "id");
    assert.equal(id.path, "ranges.sql#users.id");
    assert.equal(outlineNodeFingerprint(id), rawTextDigest(index.slice(id.range)));
    assert.equal(outlineNodeFingerprint(result.nodes[0]), result.fingerprint);
});

test("maxNodes and maxDepth truncate instead of silently dropping structure", (): void => {
    fixture("limits.sql", ["CREATE TABLE a (id INT PRIMARY KEY, name TEXT);", "CREATE TABLE b (id INT);"].join("\n"));
    const complete: OutlineResult = outline("limits.sql");
    assert.equal(complete.truncated, false);
    assert.equal(complete.nodes[0].children.length, 2);
    assert.equal(flatten(complete.nodes).length, 7);
    const limited: OutlineResult = outline("limits.sql", { maxNodes: 2 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 2);
    assert.deepEqual(labels(limited.nodes[0].children), ["a"]);
    const shallow: OutlineResult = outline("limits.sql", { maxDepth: 1 });
    assert.equal(shallow.truncated, true);
    assert.deepEqual(labels(shallow.nodes[0].children), ["a", "b"]);
    assert.equal(shallow.nodes[0].children[0].children.length, 0);
    assert.equal(shallow.nodes[0].children[1].children.length, 0);
});

test("empty, comment-only and malformed SQL never throws", (): void => {
    assert.deepEqual(direct(""), []);
    assert.deepEqual(direct("   \n\t\n"), []);
    assert.deepEqual(direct("-- CREATE TABLE ghost (id INT);\n/* CREATE TABLE ghost2 (id INT); */\n# ghost3\n"), []);
    const broken: OutlineNode[] = direct("CREATE TABLE broken (");
    assert.equal(broken.length, 1);
    assert.equal(broken[0].label, "broken");
    assert.equal(broken[0].children.length, 0);
    assert.deepEqual(direct("CREATE TABLE;"), []);
    assert.deepEqual(direct("ALTER TABLE;"), []);
    assert.equal(detectSqlDialect("-- only a comment\n"), "postgresql");
});

test("an explicit dialect overrides detection in parseSql", (): void => {
    const nodes: OutlineNode[] = direct(SqliteText, "mysql");
    assert.equal(requireNode(nodes, "accounts").detail, "mysql:table");
    const oracleNodes: OutlineNode[] = direct(OracleText);
    assert.equal(requireNode(oracleNodes, "app.customers").detail, "oracle:table");
    const overridden: OutlineNode[] = direct(OracleText, "postgresql");
    assert.equal(requireNode(overridden, "app.customers").detail, "postgresql:table");
    assert.equal(requireNode(overridden, "app.add_customer").detail, "postgresql:procedure");
});
