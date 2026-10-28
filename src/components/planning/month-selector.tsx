import { formatMonth, monthOptions } from "@/app/_lib/planning-ui";
import { buttonClasses } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ro } from "@/messages/ro";

/**
 * Selectorul de lună: un formular GET (`?month=YYYY-MM`), deci funcționează și fără JavaScript și
 * vederea se poate salva. Oferă ultimele 12 luni; o lună mai veche din fereastra de 60 (venită din
 * URL) apare și ea în listă, ca selecția să rămână corectă.
 */
export function MonthSelector({
  action,
  month,
  current,
  id = "month",
}: Readonly<{ action: string; month: string; current: string; id?: string }>) {
  const options = monthOptions(current);
  if (!options.includes(month)) options.push(month);
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{ro.planning.month}</Label>
        <Select id={id} name="month" defaultValue={month} className="w-auto min-w-44">
          {options.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
        </Select>
      </div>
      <button type="submit" className={buttonClasses("secondary")}>
        {ro.planning.showMonth}
      </button>
    </form>
  );
}
