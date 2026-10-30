-- FINET 0019_ask_finet_task (Faza 10, F10-C, pasul LLM; ADR 0026): două valori noi în liste de
-- valori permise, nimic altceva:
--   1. sarcina `ask_finet` în `finet.ai_calls` (constrângerea `ai_calls_task_valid`), ca apelurile
--      de traducere a întrebărilor („Întreabă FINET”) să lase același rând de metadate ca
--      celelalte apeluri AI (fără conținut: doar sarcina, modelul, costul, durata, rezultatul);
--   2. consimțământul `external_ai_ask` în `finet.consents` (constrângerea `consents_kind_valid`):
--      trimiterea textului întrebărilor la un model extern cere un acord SEPARAT de cel pentru
--      pozele bonurilor (`external_ai`).
-- Celelalte valori rămân. Nicio coloană nouă, nicio rescriere de date, nicio politică nouă, niciun
-- tabel nou.
--
-- Scrisă de mână (o constrângere CHECK se înlocuiește: DROP + ADD, în aceeași tranzacție a
-- runner-ului). NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Rollback (manual, de operator, cu backup; doar dacă nu există rânduri cu valorile noi):
--   delete from finet.ai_calls where task = 'ask_finet';
--   delete from finet.consents where kind = 'external_ai_ask';
--   alter table finet.ai_calls drop constraint ai_calls_task_valid;
--   alter table finet.ai_calls add constraint ai_calls_task_valid check (task in
--     ('receipt_extract', 'categorize', 'statement_extract', 'list_match', 'monthly_summary'));
--   alter table finet.consents drop constraint consents_kind_valid;
--   alter table finet.consents add constraint consents_kind_valid check (kind in
--     ('external_ai', 'external_ai_statements', 'usage_stats'));
ALTER TABLE "finet"."ai_calls" DROP CONSTRAINT "ai_calls_task_valid";
--> statement-breakpoint
ALTER TABLE "finet"."ai_calls" ADD CONSTRAINT "ai_calls_task_valid" CHECK ("finet"."ai_calls"."task" in ('receipt_extract', 'categorize', 'statement_extract', 'list_match', 'monthly_summary', 'ask_finet'));
--> statement-breakpoint
ALTER TABLE "finet"."consents" DROP CONSTRAINT "consents_kind_valid";
--> statement-breakpoint
ALTER TABLE "finet"."consents" ADD CONSTRAINT "consents_kind_valid" CHECK ("finet"."consents"."kind" in ('external_ai', 'external_ai_statements', 'usage_stats', 'external_ai_ask'));
