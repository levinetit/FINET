/// Aritmetică monetară FINET pe client (master prompt 5, promptul Android §7).
///
/// Sumele sunt `int` în unități minore (1 RON = 100 bani), niciodată `double`. Pe Android `int`
/// are 64 de biți; serverul trimite însă întregi JSON sub 2^53, deci peste [maxJsonSafeMinor] o
/// sumă se respinge, ca în aplicația web. Monedele diferite nu se adună.
library;

/// Monedele permise pe cont (ISO 4217), ca în `src/lib/money.ts`.
enum Currency {
  ron('RON', 'lei', 2),
  eur('EUR', '€', 2),
  usd('USD', r'$', 2);

  const Currency(this.code, this.symbol, this.minorUnitDigits);

  /// Codul ISO 4217, cum circulă în API.
  final String code;

  /// Simbolul afișat după sumă (`1.234,56 lei`).
  final String symbol;

  /// Numărul de zecimale ale unității minore.
  final int minorUnitDigits;

  /// Moneda pentru un cod din API; `null` dacă nu e permisă.
  static Currency? tryParse(Object? code) {
    for (final c in Currency.values) {
      if (c.code == code) return c;
    }
    return null;
  }
}

/// Plafonul sigur pentru JSON (6.4): sumele circulă ca întregi sub 2^53.
const int maxJsonSafeMinor = 9007199254740991;

/// Eroare de bază pentru modulul monetar.
class MoneyException implements Exception {
  const MoneyException(this.message);
  final String message;

  @override
  String toString() => 'MoneyException: $message';
}

/// Operație între sume în monede diferite.
class CurrencyMismatchException extends MoneyException {
  CurrencyMismatchException(Currency a, Currency b)
    : super('Monede diferite: ${a.code} și ${b.code}.');
}

/// Sumă în unități minore plus moneda ei. Imuabilă.
class Money {
  const Money(this.amountMinor, this.currency);

  const Money.zero(this.currency) : amountMinor = 0;

  /// Inversul lui [toJson]: acceptă doar `{amountMinor: int, currency: <monedă permisă>}`.
  factory Money.fromJson(Object? value) {
    if (value is! Map) throw const MoneyException('Sumă invalidă în răspuns.');
    final minor = value['amountMinor'];
    final currency = Currency.tryParse(value['currency']);
    if (minor is! int || currency == null) {
      throw const MoneyException('Sumă invalidă în răspuns.');
    }
    if (minor.abs() > maxJsonSafeMinor) {
      throw const MoneyException('Suma este în afara intervalului.');
    }
    return Money(minor, currency);
  }

  final int amountMinor;
  final Currency currency;

  Money operator +(Money other) {
    _sameCurrency(other);
    return Money(amountMinor + other.amountMinor, currency);
  }

  Money operator -(Money other) {
    _sameCurrency(other);
    return Money(amountMinor - other.amountMinor, currency);
  }

  Money operator -() => Money(-amountMinor, currency);

  bool get isZero => amountMinor == 0;
  bool get isNegative => amountMinor < 0;

  /// Compară două sume în aceeași monedă: -1, 0 sau 1.
  int compareTo(Money other) {
    _sameCurrency(other);
    return amountMinor.compareTo(other.amountMinor);
  }

  /// Suma unei liste; moneda e obligatorie, ca lista goală să aibă un rezultat definit.
  static Money sum(Iterable<Money> list, Currency currency) {
    var total = Money.zero(currency);
    for (final m in list) {
      total += m;
    }
    return total;
  }

  Map<String, Object> toJson() => {
    'amountMinor': amountMinor,
    'currency': currency.code,
  };

  void _sameCurrency(Money other) {
    if (currency != other.currency) {
      throw CurrencyMismatchException(currency, other.currency);
    }
  }

  @override
  bool operator ==(Object other) =>
      other is Money &&
      other.amountMinor == amountMinor &&
      other.currency == currency;

  @override
  int get hashCode => Object.hash(amountMinor, currency);

  @override
  String toString() => 'Money($amountMinor ${currency.code})';
}
