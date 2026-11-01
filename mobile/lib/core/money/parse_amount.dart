/// Parsarea sumelor scrise de utilizator, cu aceleași reguli și aceleași cazuri de test ca
/// `parseAmount` din `src/lib/money.ts` (promptul Android §7). Fără `double`.
library;

import 'money.dart';

/// Motivele pentru care un text nu poate fi parsat ca sumă (valori stabile, ca pe web).
enum InvalidAmountReason {
  empty('Introdu o sumă.'),
  tooLong('Suma este prea lungă.'),
  invalidCharacters('Suma poate conține doar cifre, virgulă, punct și spații.'),
  invalidSign('Semnul sumei nu este valid.'),
  negativeNotAllowed('Suma nu poate fi negativă.'),
  ambiguous(
    'Suma este ambiguă. Scrie zecimalele cu virgulă, de exemplu 1234,50.',
  ),
  tooManyDecimals('Suma poate avea cel mult două zecimale.'),
  invalidFormat('Formatul sumei nu este valid.'),
  outOfRange('Suma este prea mare.');

  const InvalidAmountReason(this.message);

  /// Mesajul pentru utilizator, în română.
  final String message;
}

/// Text care nu poate fi interpretat sigur ca sumă.
class InvalidAmountException extends MoneyException {
  InvalidAmountException(this.reason) : super(reason.message);
  final InvalidAmountReason reason;
}

const int _maxInputLength = 40;

// Spații acceptate ca separator de mii: spațiu, NBSP (U+00A0), spațiu îngust NNBSP (U+202F).
final RegExp _spaceLike = RegExp('[  ]');
final RegExp _digitsOnly = RegExp(r'^\d+$');

/// Validează partea întreagă: fără separator doar cifre; cu separator un singur tip (`.`, `,` sau
/// spațiu), primul grup 1–3 cifre, restul exact 3. Întoarce cifrele sau `null`.
String? _parseIntegerPart(String part, String? forbidden) {
  if (_digitsOnly.hasMatch(part)) return part;
  final separators = part.replaceAll(RegExp(r'\d'), '').split('').toSet();
  if (separators.length != 1) return null;
  final sep = separators.first;
  if (sep == forbidden) return null;
  final groups = part.split(sep);
  if (!RegExp(r'^\d{1,3}$').hasMatch(groups.first)) return null;
  if (!groups.skip(1).every((g) => RegExp(r'^\d{3}$').hasMatch(g))) return null;
  return groups.join();
}

/// Parsează o sumă scrisă de utilizator.
///
/// Forme acceptate: `1234,56`, `1.234,56`, `1234.56`, `1 234,56`, `1.234.567`, `1234`, `0,5`
/// (0–2 zecimale). Separatorul zecimal e ULTIMUL `,` sau `.`, doar dacă după el urmează 1–2 cifre.
/// Un singur `.` sau `,` urmat de exact 3 cifre (`1.234`) e ambiguu și se respinge.
///
/// Aruncă [InvalidAmountException] cu un `reason` stabil.
Money parseAmount(
  String input,
  Currency currency, {
  bool allowNegative = false,
}) {
  Never fail(InvalidAmountReason reason) =>
      throw InvalidAmountException(reason);

  var s = input.replaceAll(_spaceLike, ' ').trim();
  if (s.isEmpty) fail(InvalidAmountReason.empty);
  if (s.length > _maxInputLength) fail(InvalidAmountReason.tooLong);

  var negative = false;
  if (s[0] == '-' || s[0] == '+') {
    negative = s[0] == '-';
    s = s.substring(1);
  }
  // Al doilea semn (inclusiv minus Unicode U+2212) oriunde în text.
  if (RegExp('[-+−]').hasMatch(s)) fail(InvalidAmountReason.invalidSign);
  if (s.isEmpty) fail(InvalidAmountReason.invalidFormat);
  if (!RegExp(r'^[\d., ]+$').hasMatch(s)) {
    fail(InvalidAmountReason.invalidCharacters);
  }
  if (!RegExp(r'^\d').hasMatch(s)) fail(InvalidAmountReason.invalidFormat);
  if (negative && !allowNegative) fail(InvalidAmountReason.negativeNotAllowed);

  final digits = currency.minorUnitDigits;
  final lastSep = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.lastIndexOf(',')
      : s.lastIndexOf('.');
  final tail = lastSep >= 0 ? s.substring(lastSep + 1) : '';

  String integerDigits;
  var fraction = '';
  if (lastSep >= 0 &&
      RegExp(r'^\d{1,2}$').hasMatch(tail) &&
      tail.length <= digits) {
    // Separator zecimal valid.
    final parsed = _parseIntegerPart(s.substring(0, lastSep), s[lastSep]);
    if (parsed == null) fail(InvalidAmountReason.invalidFormat);
    integerDigits = parsed;
    fraction = tail;
  } else {
    final parsed = _parseIntegerPart(s, null);
    if (parsed != null) {
      // Un singur `.`/`,` urmat de 3 cifre: 1.234 poate fi 1234 sau 1,234.
      final single = s.replaceAll(RegExp(r'[\d ]'), '');
      if (single.length == 1) fail(InvalidAmountReason.ambiguous);
      integerDigits = parsed;
    } else {
      // Partea dinaintea ultimului separator e validă și după el urmează 3+ cifre: prea multe
      // zecimale (`1234,567`); altfel forma e pur și simplu greșită (`1.23.456`).
      if (lastSep >= 0 &&
          RegExp(r'^\d{3,}$').hasMatch(tail) &&
          _parseIntegerPart(s.substring(0, lastSep), s[lastSep]) != null) {
        fail(InvalidAmountReason.tooManyDecimals);
      }
      fail(InvalidAmountReason.invalidFormat);
    }
  }

  // Peste 18 cifre `int.parse` ar depăși 64 de biți; plafonul real e 2^53 − 1.
  final whole = integerDigits.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  if (whole.length > 16) fail(InvalidAmountReason.outOfRange);
  var scale = 1;
  for (var i = 0; i < digits; i++) {
    scale *= 10;
  }
  final minor =
      int.parse(whole) * scale + int.parse(fraction.padRight(digits, '0'));
  if (minor > maxJsonSafeMinor) fail(InvalidAmountReason.outOfRange);
  return Money(negative ? -minor : minor, currency);
}
