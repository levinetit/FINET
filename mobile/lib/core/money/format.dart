/// Formatarea sumelor și a datelor în română (master prompt 5.3): `1.234,56 lei`,
/// `25.10.2026`. Fără `double` și fără dependență de locale-ul telefonului: rezultatul e același
/// pe orice dispozitiv, ca să poată fi comparat cu web-ul.
library;

import 'money.dart';

const String _nbsp = ' ';

/// Formatează o sumă: `1.234,56 lei`, `-1.234,56 €`. Între număr și simbol e NBSP (U+00A0).
/// Zero negativ nu există (`-0,00` nu apare).
String formatMoney(Money m) {
  final digits = m.currency.minorUnitDigits;
  final abs = m.amountMinor.abs();
  final raw = abs.toString().padLeft(digits + 1, '0');
  final integer = raw.substring(0, raw.length - digits);
  final fraction = raw.substring(raw.length - digits);
  final grouped = _group(integer);
  final sign = m.amountMinor < 0 ? '-' : '';
  final number = digits > 0 ? '$grouped,$fraction' : grouped;
  return '$sign$number$_nbsp${m.currency.symbol}';
}

/// Grupează cifrele câte trei, cu punct: `1234567` → `1.234.567`.
String _group(String integer) {
  final out = StringBuffer();
  for (var i = 0; i < integer.length; i++) {
    final fromEnd = integer.length - i;
    out.write(integer[i]);
    if (fromEnd > 1 && fromEnd % 3 == 1) out.write('.');
  }
  return out.toString();
}

String _two(int n) => n.toString().padLeft(2, '0');

/// Data calendaristică pentru afișare: `25.10.2026`.
String formatDate(DateTime d) => '${_two(d.day)}.${_two(d.month)}.${d.year}';

const List<String> _months = [
  'ianuarie',
  'februarie',
  'martie',
  'aprilie',
  'mai',
  'iunie',
  'iulie',
  'august',
  'septembrie',
  'octombrie',
  'noiembrie',
  'decembrie',
];

/// Luna în română, cu majusculă: `Octombrie 2026`.
String formatMonth(DateTime d) {
  final name = _months[d.month - 1];
  return '${name[0].toUpperCase()}${name.substring(1)} ${d.year}';
}
