import 'package:finet_mobile/core/money/money.dart';
import 'package:flutter_test/flutter_test.dart';

Money ron(int minor) => Money(minor, Currency.ron);
Money eur(int minor) => Money(minor, Currency.eur);

void main() {
  group('Money', () {
    test('aduna și scade în aceeași monedă', () {
      expect(ron(1050) + ron(250), ron(1300));
      expect(ron(1050) - ron(2000), ron(-950));
      expect(-ron(500), ron(-500));
    });

    test('monedele diferite nu se adună și nu se compară', () {
      expect(
        () => ron(100) + eur(100),
        throwsA(isA<CurrencyMismatchException>()),
      );
      expect(
        () => ron(100) - eur(100),
        throwsA(isA<CurrencyMismatchException>()),
      );
      expect(
        () => ron(100).compareTo(eur(100)),
        throwsA(isA<CurrencyMismatchException>()),
      );
    });

    test('compareTo, isZero, isNegative', () {
      expect(ron(1).compareTo(ron(2)), -1);
      expect(ron(2).compareTo(ron(2)), 0);
      expect(ron(3).compareTo(ron(2)), 1);
      expect(const Money.zero(Currency.ron).isZero, isTrue);
      expect(ron(-1).isNegative, isTrue);
      expect(ron(1).isNegative, isFalse);
    });

    test(
      'sum: lista goală dă zero în moneda cerută, un element străin aruncă',
      () {
        expect(Money.sum([], Currency.eur), eur(0));
        expect(Money.sum([ron(100), ron(250)], Currency.ron), ron(350));
        expect(
          () => Money.sum([ron(1), eur(1)], Currency.ron),
          throwsA(isA<CurrencyMismatchException>()),
        );
      },
    );

    test('egalitate și hashCode după valoare', () {
      expect(ron(10), ron(10));
      expect(ron(10).hashCode, ron(10).hashCode);
      expect(ron(10), isNot(eur(10)));
    });

    test('0,1 + 0,2 este exact 0,3 (fără float)', () {
      expect(ron(10) + ron(20), ron(30));
    });
  });

  group('JSON', () {
    test('toJson / fromJson fac drumul complet', () {
      final m = ron(123456);
      expect(m.toJson(), {'amountMinor': 123456, 'currency': 'RON'});
      expect(Money.fromJson(m.toJson()), m);
    });

    test('fromJson respinge forme invalide', () {
      expect(() => Money.fromJson(null), throwsA(isA<MoneyException>()));
      expect(
        () => Money.fromJson({'amountMinor': 12.5, 'currency': 'RON'}),
        throwsA(isA<MoneyException>()),
      );
      expect(
        () => Money.fromJson({'amountMinor': '100', 'currency': 'RON'}),
        throwsA(isA<MoneyException>()),
      );
      expect(
        () => Money.fromJson({'amountMinor': 100, 'currency': 'GBP'}),
        throwsA(isA<MoneyException>()),
      );
      expect(
        () => Money.fromJson({
          'amountMinor': maxJsonSafeMinor + 1,
          'currency': 'RON',
        }),
        throwsA(isA<MoneyException>()),
      );
      expect(
        Money.fromJson({'amountMinor': maxJsonSafeMinor, 'currency': 'RON'})
            .amountMinor,
        maxJsonSafeMinor,
      );
    });
  });

  test('Currency.tryParse', () {
    expect(Currency.tryParse('RON'), Currency.ron);
    expect(Currency.tryParse('EUR'), Currency.eur);
    expect(Currency.tryParse('USD'), Currency.usd);
    expect(Currency.tryParse('ron'), isNull);
    expect(Currency.tryParse(null), isNull);
  });
}
