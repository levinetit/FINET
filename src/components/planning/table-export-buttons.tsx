import { ExportButton } from "@/components/planning/export-button";
import { type ExportKind, exportTablePath } from "@/app/_lib/planning-ui";
import { ro } from "@/messages/ro";

const FILES: Readonly<Record<ExportKind, string>> = {
  transactions: "finet-tranzactii",
  goals: "finet-obiective",
  budgets: "finet-bugete",
};

/** Butoanele „Export Excel” și „Export PDF” (F10-C), lângă „Export CSV” al paginii. */
export function TableExportButtons({
  kind,
  search,
  testId,
}: Readonly<{ kind: ExportKind; search?: Readonly<Record<string, string>>; testId: string }>) {
  return (
    <>
      <ExportButton
        path={exportTablePath(kind, "xlsx", search)}
        label={ro.exports.xlsx}
        filename={`${FILES[kind]}.xlsx`}
        testId={`${testId}-xlsx`}
      />
      <ExportButton
        path={exportTablePath(kind, "pdf", search)}
        label={ro.exports.pdf}
        filename={`${FILES[kind]}.pdf`}
        testId={`${testId}-pdf`}
      />
    </>
  );
}
