// Tipuri pentru scripts/pgboss-plan.mjs (folosite de teste).
export declare const PGBOSS_SCHEMA: string;
export declare const MIGRATION_PATH: string;
export declare function installedSchemaVersion(): number;
export declare function splitSql(text: string): string[];
export declare function pgBossStatements(): string[];
export declare function buildPgBossMigration(): string;
