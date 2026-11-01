import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

bool _tzReady = false;

/// Încarcă baza de fusuri orare (inclusă în aplicație, fără rețea). Se apelează o dată la
/// pornire; apeluri repetate nu fac nimic.
void initTimezones() {
  if (_tzReady) return;
  tzdata.initializeTimeZones();
  _tzReady = true;
}

/// O lună calendaristică (`YYYY-MM`), cum o cere API-ul pentru dashboard, bugete și rapoarte.
class YearMonth implements Comparable<YearMonth> {
  const YearMonth(this.year, this.month)
    : assert(month >= 1 && month <= 12, 'luna trebuie să fie 1–12');

  factory YearMonth.fromDate(DateTime d) => YearMonth(d.year, d.month);

  /// Din `YYYY-MM`; `null` dacă forma e greșită.
  static YearMonth? tryParse(String text) {
    final m = RegExp(r'^(\d{4})-(0[1-9]|1[0-2])$').firstMatch(text);
    if (m == null) return null;
    return YearMonth(int.parse(m.group(1)!), int.parse(m.group(2)!));
  }

  final int year;
  final int month;

  YearMonth get previous =>
      month == 1 ? YearMonth(year - 1, 12) : YearMonth(year, month - 1);

  YearMonth get next =>
      month == 12 ? YearMonth(year + 1, 1) : YearMonth(year, month + 1);

  /// Prima zi a lunii.
  DateTime get firstDay => DateTime(year, month);

  /// Ultima zi a lunii.
  DateTime get lastDay => DateTime(year, month + 1, 0);

  /// Forma din API: `2026-10`.
  String get api => '$year-${month.toString().padLeft(2, '0')}';

  @override
  int compareTo(YearMonth other) =>
      year != other.year ? year - other.year : month - other.month;

  bool operator <(YearMonth other) => compareTo(other) < 0;
  bool operator >(YearMonth other) => compareTo(other) > 0;

  @override
  bool operator ==(Object other) =>
      other is YearMonth && other.year == year && other.month == month;

  @override
  int get hashCode => Object.hash(year, month);

  @override
  String toString() => api;
}

/// Data de azi în fusul orar dat (al gospodăriei, de obicei `Europe/Bucharest`), ca dată
/// calendaristică fără oră. Dacă fusul nu e cunoscut, se folosește `Europe/Bucharest`.
DateTime todayIn(DateTime now, String timezone) {
  tz.Location location;
  try {
    location = tz.getLocation(timezone);
  } on Object {
    location = tz.getLocation('Europe/Bucharest');
  }
  final local = tz.TZDateTime.from(now.toUtc(), location);
  return DateTime(local.year, local.month, local.day);
}

/// Data calendaristică pentru API: `2026-10-25`.
String apiDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// Inversul lui [apiDate]; `null` dacă forma e greșită.
DateTime? parseApiDate(String text) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(text);
  if (m == null) return null;
  final d = DateTime(
    int.parse(m.group(1)!),
    int.parse(m.group(2)!),
    int.parse(m.group(3)!),
  );
  return apiDate(d) == text ? d : null;
}
