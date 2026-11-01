import '../money/money.dart';

/// DATE SIMULATE (Faza A, promptul Android §8): toate valorile de mai jos sunt inventate și
/// există doar ca să se vadă ecranele. Nu provin din FINET și nu se afișează niciodată fără
/// eticheta „Date simulate”. Dispar în Faza C, când ecranele citesc din API.
class MockCategoryTotal {
  const MockCategoryTotal(this.name, this.amount);
  final String name;
  final Money amount;
}

class MockTransaction {
  const MockTransaction({
    required this.description,
    required this.category,
    required this.date,
    required this.amount,
  });

  final String description;
  final String category;
  final DateTime date;

  /// Cu semn: cheltuielile sunt negative, veniturile pozitive (doar pentru afișare).
  final Money amount;
}

class MockSummary {
  const MockSummary({
    required this.month,
    required this.income,
    required this.expenses,
    required this.transactionCount,
    required this.categories,
  });

  final DateTime month;
  final Money income;
  final Money expenses;
  final int transactionCount;
  final List<MockCategoryTotal> categories;

  Money get net => income - expenses;
}

const _ron = Currency.ron;

final MockSummary mockSummary = MockSummary(
  month: DateTime(2026, 10),
  income: const Money(780000, _ron),
  expenses: const Money(512345, _ron),
  transactionCount: 37,
  categories: const [
    MockCategoryTotal('Alimente', Money(184500, _ron)),
    MockCategoryTotal('Locuință', Money(150000, _ron)),
    MockCategoryTotal('Transport', Money(62345, _ron)),
    MockCategoryTotal('Abonamente', Money(41000, _ron)),
    MockCategoryTotal('Altele', Money(74500, _ron)),
  ],
);

final List<MockTransaction> mockTransactions = [
  MockTransaction(
    description: 'Cumpărături săptămânale',
    category: 'Alimente',
    date: DateTime(2026, 10, 24),
    amount: const Money(-23480, _ron),
  ),
  MockTransaction(
    description: 'Salariu',
    category: 'Venituri',
    date: DateTime(2026, 10, 20),
    amount: const Money(780000, _ron),
  ),
  MockTransaction(
    description: 'Abonament telefon',
    category: 'Abonamente',
    date: DateTime(2026, 10, 18),
    amount: const Money(-4500, _ron),
  ),
  MockTransaction(
    description: 'Combustibil',
    category: 'Transport',
    date: DateTime(2026, 10, 15),
    amount: const Money(-28000, _ron),
  ),
  MockTransaction(
    description: 'Chirie',
    category: 'Locuință',
    date: DateTime(2026, 10, 5),
    amount: const Money(-150000, _ron),
  ),
];
