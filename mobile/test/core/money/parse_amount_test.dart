import 'package:finet_mobile/core/money/money.dart';
import 'package:finet_mobile/core/money/parse_amount.dart';
import 'package:flutter_test/flutter_test.dart';

// Aceleași cazuri ca `src/lib/money.test.ts` (parseAmount), ca web-ul și aplicația să primească
// și să respingă exact aceleași texte.
const nbsp = ' ';
const nnbsp = ' ';

void main() {
  final valid = <String, int>{
    '1234,56': 123456,
    '1.234,56': 123456,
    '1234.56': 123456,
    '1 234,56': 123456,
    '1${nbsp}234,56': 123456,
    '1${nnbsp}234,56': 123456,
    '1.234.567,89': 123456789,
    '1 234 567,89': 123456789,
    '1.234.567': 123456700,
    '1,234,567': 123456700,
    '1,234.56': 123456,
    '1234': 123400,
    '0': 0,
    '0,5': 50,
    '0,05': 5,
    '12,5': 1250,
    '12.5': 1250,
    '12,50': 1250,
    '1 234': 123400,
    '  42,10  ': 4210,
    '+7': 700,
    '007,50': 750,
    '999': 99900,
    '90071992547409,91': 9007199254740991,
  };

  group('acceptă', () {
    valid.forEach((input, expected) {
      test('"$input"', () {
        expect(parseAmount(input, Currency.ron), Money(expected, Currency.ron));
      });
    });

    test('păstrează moneda cerută', () {
      expect(parseAmount('5,00', Currency.eur), const Money(500, Currency.eur));
    });
  });

  final invalid = <String, InvalidAmountReason>{
    '': InvalidAmountReason.empty,
    '   ': InvalidAmountReason.empty,
    '1.234': InvalidAmountReason.ambiguous,
    '1,234': InvalidAmountReason.ambiguous,
    '12.345': InvalidAmountReason.ambiguous,
    '1.2.3': InvalidAmountReason.invalidFormat,
    '1,2,3': InvalidAmountReason.invalidFormat,
    '1.234.56': InvalidAmountReason.invalidFormat,
    '1,234,56': InvalidAmountReason.invalidFormat,
    '1234,567': InvalidAmountReason.tooManyDecimals,
    '1,2345': InvalidAmountReason.tooManyDecimals,
    '1.234,567': InvalidAmountReason.tooManyDecimals,
    '1.234 567': InvalidAmountReason.invalidFormat,
    '1.234 567,89': InvalidAmountReason.invalidFormat,
    '12 34': InvalidAmountReason.invalidFormat,
    '1  234': InvalidAmountReason.invalidFormat,
    '12,': InvalidAmountReason.invalidFormat,
    '12.': InvalidAmountReason.invalidFormat,
    ',50': InvalidAmountReason.invalidFormat,
    '.5': InvalidAmountReason.invalidFormat,
    '1.23.456': InvalidAmountReason.invalidFormat,
    '--1': InvalidAmountReason.invalidSign,
    '+-1': InvalidAmountReason.invalidSign,
    '1-': InvalidAmountReason.invalidSign,
    '1-2': InvalidAmountReason.invalidSign,
    '−5': InvalidAmountReason.invalidSign,
    '5−': InvalidAmountReason.invalidSign,
    '-': InvalidAmountReason.invalidFormat,
    '-12': InvalidAmountReason.negativeNotAllowed,
    '- 12': InvalidAmountReason.invalidFormat,
    'abc': InvalidAmountReason.invalidCharacters,
    '12,50 lei': InvalidAmountReason.invalidCharacters,
    '1e5': InvalidAmountReason.invalidCharacters,
    'Infinity': InvalidAmountReason.invalidCharacters,
    'NaN': InvalidAmountReason.invalidCharacters,
    '0x10': InvalidAmountReason.invalidCharacters,
    '12_000': InvalidAmountReason.invalidCharacters,
    '90071992547409,92': InvalidAmountReason.outOfRange,
    '9' * 41: InvalidAmountReason.tooLong,
  };

  group('respinge', () {
    invalid.forEach((input, reason) {
      test('"$input" (${reason.name})', () {
        try {
          parseAmount(input, Currency.ron);
          fail('trebuia respins: $input');
        } on InvalidAmountException catch (e) {
          expect(e.reason, reason);
          expect(e.message, isNotEmpty);
        }
      });
    });
  });

  test('sume negative, doar cu allowNegative', () {
    expect(
      parseAmount('-12,50', Currency.ron, allowNegative: true),
      const Money(-1250, Currency.ron),
    );
    expect(
      parseAmount('-1.234,56', Currency.ron, allowNegative: true),
      const Money(-123456, Currency.ron),
    );
  });

  test(
    'o parte întreagă foarte lungă nu depășește 64 de biți, ci dă out_of_range',
    () {
      expect(
        () => parseAmount('9' * 18, Currency.ron),
        throwsA(
          isA<InvalidAmountException>().having(
            (e) => e.reason,
            'reason',
            InvalidAmountReason.outOfRange,
          ),
        ),
      );
    },
  );
}
