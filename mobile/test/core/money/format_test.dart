import 'package:finet_mobile/core/money/format.dart';
import 'package:finet_mobile/core/money/money.dart';
import 'package:finet_mobile/core/money/parse_amount.dart';
import 'package:flutter_test/flutter_test.dart';

const nbsp = ' ';
Money ron(int minor) => Money(minor, Currency.ron);

void main() {
  group('formatMoney', () {
    test('RON cu separator de mii și virgulă', () {
      expect(formatMoney(ron(123456)), '1.234,56${nbsp}lei');
      expect(formatMoney(ron(0)), '0,00${nbsp}lei');
      expect(formatMoney(ron(5)), '0,05${nbsp}lei');
      expect(formatMoney(ron(99999)), '999,99${nbsp}lei');
      expect(formatMoney(ron(100)), '1,00${nbsp}lei');
      expect(formatMoney(ron(100000000)), '1.000.000,00${nbsp}lei');
    });

    test('EUR și USD', () {
      expect(formatMoney(const Money(123456, Currency.eur)), '1.234,56$nbsp€');
      expect(formatMoney(const Money(123456, Currency.usd)), '1.234,56$nbsp\$');
    });

    test('sume negative; zero nu are semn', () {
      expect(formatMoney(ron(-123456)), '-1.234,56${nbsp}lei');
      expect(formatMoney(ron(-5)), '-0,05${nbsp}lei');
      expect(formatMoney(-ron(0)), '0,00${nbsp}lei');
    });

    test('peste 2^53 rămâne exact', () {
      expect(
        formatMoney(ron(9007199254740993)),
        '90.071.992.547.409,93${nbsp}lei',
      );
      expect(
        formatMoney(ron(-9007199254740993)),
        '-90.071.992.547.409,93${nbsp}lei',
      );
    });

    test('drumul complet: ce afișează aplicația se parsează înapoi la aceeași sumă', () {
      for (final minor in [
        0,
        1,
        5,
        99,
        100,
        1234,
        123456,
        100000000,
        9007199254740991,
      ]) {
        final shown = formatMoney(ron(minor)).replaceAll('${nbsp}lei', '');
        expect(parseAmount(shown, Currency.ron), ron(minor), reason: shown);
      }
    });
  });

  group('date', () {
    test('formatDate: ZZ.LL.AAAA', () {
      expect(formatDate(DateTime(2026, 10, 25)), '25.10.2026');
      expect(formatDate(DateTime(2026, 1, 5)), '05.01.2026');
    });

    test('formatMonth: luna în română', () {
      expect(formatMonth(DateTime(2026, 10)), 'Octombrie 2026');
      expect(formatMonth(DateTime(2026, 3, 15)), 'Martie 2026');
    });
  });
}
