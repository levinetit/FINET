import '../../core/money/money.dart';
import '../../core/time/period.dart';

/// Modelele răspunsurilor FINET pentru Faza C, scrise de mână după `docs/openapi.json`.
/// Un câmp lipsă sau de alt tip aruncă [FormatException] (clientul îl arată ca „răspuns
/// neașteptat”); nu se completează niciodată cu valori inventate. Sumele rămân `int` în unități
/// minore, iar clientul nu recalculează nimic: afișează ce a calculat serverul.

typedef JsonMap = Map<String, Object?>;

/// Citire strictă din JSON.
abstract final class Json {
  static JsonMap map(Object? value, [String what = 'obiect']) {
    if (value is! Map) throw FormatException('Se aștepta $what.');
    return Map<String, Object?>.from(value);
  }

  static List<JsonMap> list(Object? value, [String what = 'listă']) {
    if (value is! List) throw FormatException('Se aștepta $what.');
    return [for (final item in value) map(item)];
  }

  static String str(JsonMap m, String key) {
    final v = m[key];
    if (v is! String) throw FormatException('Câmp lipsă: $key');
    return v;
  }

  static String? strOrNull(JsonMap m, String key) {
    final v = m[key];
    if (v == null) return null;
    if (v is! String) throw FormatException('Câmp invalid: $key');
    return v;
  }

  static int integer(JsonMap m, String key) {
    final v = m[key];
    if (v is! int) throw FormatException('Câmp lipsă: $key');
    return v;
  }

  static int? integerOrNull(JsonMap m, String key) {
    final v = m[key];
    if (v == null) return null;
    if (v is! int) throw FormatException('Câmp invalid: $key');
    return v;
  }

  static bool boolean(JsonMap m, String key) {
    final v = m[key];
    if (v is! bool) throw FormatException('Câmp lipsă: $key');
    return v;
  }

  static Currency currency(JsonMap m, String key) {
    final c = Currency.tryParse(m[key]);
    if (c == null) throw FormatException('Monedă invalidă: $key');
    return c;
  }
}

// ---------------------------------------------------------------------------------------------
// Conturi, categorii, etichete
// ---------------------------------------------------------------------------------------------

enum AccountType {
  cash('cash', 'Numerar'),
  bank('bank', 'Cont bancar'),
  savings('savings', 'Economii'),
  creditCard('credit_card', 'Card de credit');

  const AccountType(this.api, this.label);
  final String api;
  final String label;

  static AccountType parse(String value) => AccountType.values.firstWhere(
    (t) => t.api == value,
    orElse: () => throw FormatException('Tip de cont necunoscut: $value'),
  );
}

class Account {
  const Account({
    required this.id,
    required this.name,
    required this.type,
    required this.currency,
    required this.balanceMinor,
    required this.archived,
  });

  factory Account.fromJson(JsonMap j) => Account(
    id: Json.str(j, 'id'),
    name: Json.str(j, 'name'),
    type: AccountType.parse(Json.str(j, 'type')),
    currency: Json.currency(j, 'currency'),
    balanceMinor: Json.integer(j, 'balanceMinor'),
    archived: Json.boolean(j, 'archived'),
  );

  final String id;
  final String name;
  final AccountType type;
  final Currency currency;
  final int balanceMinor;
  final bool archived;

  Money get balance => Money(balanceMinor, currency);
}

/// Conturile și totalurile pe monedă (`GET /api/v1/accounts`).
class AccountsResult {
  const AccountsResult({required this.accounts, required this.totals});

  factory AccountsResult.fromJson(JsonMap j) => AccountsResult(
    accounts: [for (final a in Json.list(j['data'])) Account.fromJson(a)],
    totals: [for (final t in Json.list(j['totals'])) Money.fromJson(t)],
  );

  final List<Account> accounts;
  final List<Money> totals;
}

class Category {
  const Category({
    required this.id,
    required this.name,
    required this.kind,
    required this.hidden,
    this.parentId,
  });

  factory Category.fromJson(JsonMap j) => Category(
    id: Json.str(j, 'id'),
    name: Json.str(j, 'name'),
    kind: TxType.parse(Json.str(j, 'kind')),
    hidden: Json.boolean(j, 'hidden'),
    parentId: Json.strOrNull(j, 'parentId'),
  );

  final String id;
  final String name;

  /// `income` sau `expense`.
  final TxType kind;
  final bool hidden;
  final String? parentId;
}

class Tag {
  const Tag({required this.id, required this.name, required this.hidden});

  factory Tag.fromJson(JsonMap j) => Tag(
    id: Json.str(j, 'id'),
    name: Json.str(j, 'name'),
    hidden: Json.boolean(j, 'hidden'),
  );

  final String id;
  final String name;
  final bool hidden;
}

// ---------------------------------------------------------------------------------------------
// Tranzacții
// ---------------------------------------------------------------------------------------------

enum TxType {
  income('income', 'Venit'),
  expense('expense', 'Cheltuială'),
  transfer('transfer', 'Transfer');

  const TxType(this.api, this.label);
  final String api;
  final String label;

  static TxType parse(String value) => TxType.values.firstWhere(
    (t) => t.api == value,
    orElse: () => throw FormatException('Tip de tranzacție necunoscut: $value'),
  );
}

class TxTag {
  const TxTag({required this.id, required this.name});
  final String id;
  final String name;
}

class FinTransaction {
  const FinTransaction({
    required this.id,
    required this.accountId,
    required this.type,
    required this.amountMinor,
    required this.currency,
    required this.occurredOn,
    required this.tags,
    this.categoryId,
    this.description,
    this.merchant,
    this.notes,
    this.transferGroupId,
  });

  factory FinTransaction.fromJson(JsonMap j) {
    final occurred = parseApiDate(Json.str(j, 'occurredOn'));
    if (occurred == null) {
      throw const FormatException('Dată invalidă: occurredOn');
    }
    return FinTransaction(
      id: Json.str(j, 'id'),
      accountId: Json.str(j, 'accountId'),
      type: TxType.parse(Json.str(j, 'type')),
      amountMinor: Json.integer(j, 'amountMinor'),
      currency: Json.currency(j, 'currency'),
      occurredOn: occurred,
      categoryId: Json.strOrNull(j, 'categoryId'),
      description: Json.strOrNull(j, 'description'),
      merchant: Json.strOrNull(j, 'merchant'),
      notes: Json.strOrNull(j, 'notes'),
      transferGroupId: Json.strOrNull(j, 'transferGroupId'),
      tags: [
        for (final t in Json.list(j['tags']))
          TxTag(id: Json.str(t, 'id'), name: Json.str(t, 'name')),
      ],
    );
  }

  final String id;
  final String accountId;
  final TxType type;

  /// Mereu pozitivă; semnul vine din [type] (master prompt 5.1).
  final int amountMinor;
  final Currency currency;
  final DateTime occurredOn;
  final String? categoryId;
  final String? description;
  final String? merchant;
  final String? notes;
  final String? transferGroupId;
  final List<TxTag> tags;

  /// Rândurile unui transfer nu se editează și nu se șterg individual.
  bool get isTransfer => type == TxType.transfer;

  /// Suma cu semn pentru afișare: cheltuiala negativă, venitul pozitiv, transferul neutru.
  Money get signed => Money(switch (type) {
    TxType.expense => -amountMinor,
    TxType.income => amountMinor,
    TxType.transfer => amountMinor,
  }, currency);

  /// Titlul din listă: descrierea, apoi comerciantul, apoi tipul.
  String get title {
    final d = description?.trim();
    if (d != null && d.isNotEmpty) return d;
    final m = merchant?.trim();
    if (m != null && m.isNotEmpty) return m;
    return type.label;
  }
}

class TransactionPage {
  const TransactionPage({required this.items, this.nextCursor});

  factory TransactionPage.fromJson(JsonMap j) => TransactionPage(
    items: [for (final t in Json.list(j['data'])) FinTransaction.fromJson(t)],
    nextCursor: Json.strOrNull(j, 'nextCursor'),
  );

  final List<FinTransaction> items;
  final String? nextCursor;
}

/// Filtrele listei de tranzacții.
class TransactionFilters {
  const TransactionFilters({
    this.query = '',
    this.accountId,
    this.categoryId,
    this.type,
    this.dateFrom,
    this.dateTo,
  });

  final String query;
  final String? accountId;
  final String? categoryId;
  final TxType? type;
  final DateTime? dateFrom;
  final DateTime? dateTo;

  bool get isEmpty =>
      query.isEmpty &&
      accountId == null &&
      categoryId == null &&
      type == null &&
      dateFrom == null &&
      dateTo == null;

  /// Numărul de filtre active, fără căutare (pentru insigna butonului).
  int get activeCount =>
      [accountId, categoryId, type, dateFrom, dateTo].nonNulls.length;

  TransactionFilters copyWith({
    String? query,
    String? Function()? accountId,
    String? Function()? categoryId,
    TxType? Function()? type,
    DateTime? Function()? dateFrom,
    DateTime? Function()? dateTo,
  }) => TransactionFilters(
    query: query ?? this.query,
    accountId: accountId != null ? accountId() : this.accountId,
    categoryId: categoryId != null ? categoryId() : this.categoryId,
    type: type != null ? type() : this.type,
    dateFrom: dateFrom != null ? dateFrom() : this.dateFrom,
    dateTo: dateTo != null ? dateTo() : this.dateTo,
  );

  /// Parametrii cererii `GET /api/v1/transactions`.
  Map<String, String> toQuery() => {
    if (query.trim().isNotEmpty) 'q': query.trim(),
    'accountId': ?accountId,
    'categoryId': ?categoryId,
    if (type != null) 'type': type!.api,
    if (dateFrom != null) 'dateFrom': apiDate(dateFrom!),
    if (dateTo != null) 'dateTo': apiDate(dateTo!),
  };
}

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

class PeriodTotals {
  const PeriodTotals({
    required this.incomeMinor,
    required this.expenseMinor,
    required this.netMinor,
    required this.transactionCount,
  });

  factory PeriodTotals.fromJson(JsonMap j) => PeriodTotals(
    incomeMinor: Json.integer(j, 'incomeMinor'),
    expenseMinor: Json.integer(j, 'expenseMinor'),
    netMinor: Json.integer(j, 'netMinor'),
    transactionCount: Json.integer(j, 'transactionCount'),
  );

  final int incomeMinor;
  final int expenseMinor;
  final int netMinor;
  final int transactionCount;
}

/// Diferența față de luna anterioară; `percent` e `null` când luna anterioară e zero.
class Change {
  const Change({required this.diffMinor, this.percent});

  factory Change.fromJson(JsonMap j) => Change(
    diffMinor: Json.integer(j, 'diffMinor'),
    percent: Json.integerOrNull(j, 'percent'),
  );

  final int diffMinor;
  final int? percent;
}

class CategoryShare {
  const CategoryShare({
    required this.name,
    required this.amountMinor,
    required this.percent,
    required this.isOther,
  });

  factory CategoryShare.fromJson(JsonMap j) => CategoryShare(
    name: Json.strOrNull(j, 'name') ?? 'Fără categorie',
    amountMinor: Json.integer(j, 'amountMinor'),
    percent: Json.integer(j, 'percent'),
    isOther: j['isOther'] == true,
  );

  final String name;
  final int amountMinor;
  final int percent;
  final bool isOther;
}

class MonthPoint {
  const MonthPoint({
    required this.month,
    required this.incomeMinor,
    required this.expenseMinor,
    required this.netMinor,
  });

  factory MonthPoint.fromJson(JsonMap j) {
    final month = YearMonth.tryParse(Json.str(j, 'month'));
    if (month == null) throw const FormatException('Lună invalidă');
    return MonthPoint(
      month: month,
      incomeMinor: Json.integer(j, 'incomeMinor'),
      expenseMinor: Json.integer(j, 'expenseMinor'),
      netMinor: Json.integer(j, 'netMinor'),
    );
  }

  final YearMonth month;
  final int incomeMinor;
  final int expenseMinor;
  final int netMinor;
}

/// Dashboard-ul unei monede (sumele nu se adună între monede).
class CurrencyDashboard {
  const CurrencyDashboard({
    required this.currency,
    required this.totals,
    required this.previous,
    required this.income,
    required this.expense,
    required this.net,
    required this.byCategory,
    required this.monthly,
  });

  factory CurrencyDashboard.fromJson(JsonMap j) {
    final cmp = Json.map(j['comparison']);
    return CurrencyDashboard(
      currency: Json.currency(j, 'currency'),
      totals: PeriodTotals.fromJson(Json.map(j['totals'])),
      previous: PeriodTotals.fromJson(Json.map(j['previous'])),
      income: Change.fromJson(Json.map(cmp['income'])),
      expense: Change.fromJson(Json.map(cmp['expense'])),
      net: Change.fromJson(Json.map(cmp['net'])),
      byCategory: [
        for (final c in Json.list(j['byCategory'])) CategoryShare.fromJson(c),
      ],
      monthly: [
        for (final m in Json.list(j['monthly'])) MonthPoint.fromJson(m),
      ],
    );
  }

  final Currency currency;
  final PeriodTotals totals;
  final PeriodTotals previous;
  final Change income;
  final Change expense;
  final Change net;
  final List<CategoryShare> byCategory;
  final List<MonthPoint> monthly;

  Money money(int minor) => Money(minor, currency);
}

class DashboardData {
  const DashboardData({
    required this.month,
    required this.currencies,
    required this.hasAccount,
    required this.hasTransaction,
  });

  factory DashboardData.fromJson(JsonMap j) {
    final month = YearMonth.tryParse(Json.str(j, 'month'));
    if (month == null) throw const FormatException('Lună invalidă');
    final onboarding = Json.map(j['onboarding']);
    return DashboardData(
      month: month,
      currencies: [
        for (final c in Json.list(j['currencies']))
          CurrencyDashboard.fromJson(c),
      ],
      hasAccount: Json.boolean(onboarding, 'hasAccount'),
      hasTransaction: Json.boolean(onboarding, 'hasTransaction'),
    );
  }

  final YearMonth month;
  final List<CurrencyDashboard> currencies;
  final bool hasAccount;
  final bool hasTransaction;
}

// ---------------------------------------------------------------------------------------------
// Bugete, obiective, raport lunar
// ---------------------------------------------------------------------------------------------

enum BudgetLight {
  green('green', 'În limită'),
  yellow('yellow', 'Aproape de limită'),
  red('red', 'Depășit');

  const BudgetLight(this.api, this.label);
  final String api;
  final String label;

  static BudgetLight parse(String value) => BudgetLight.values.firstWhere(
    (l) => l.api == value,
    orElse: () => throw FormatException('Stare de buget necunoscută: $value'),
  );
}

class BudgetStatusItem {
  const BudgetStatusItem({
    required this.id,
    required this.categoryId,
    required this.currency,
    required this.amountMinor,
    required this.spentMinor,
    required this.remainingMinor,
    required this.percent,
    required this.status,
    required this.personal,
  });

  factory BudgetStatusItem.fromJson(JsonMap j) => BudgetStatusItem(
    id: Json.str(j, 'id'),
    categoryId: Json.strOrNull(j, 'categoryId'),
    currency: Json.currency(j, 'currency'),
    amountMinor: Json.integer(j, 'amountMinor'),
    spentMinor: Json.integer(j, 'spentMinor'),
    remainingMinor: Json.integer(j, 'remainingMinor'),
    percent: Json.integer(j, 'percent'),
    status: BudgetLight.parse(Json.str(j, 'status')),
    personal: Json.str(j, 'scope') == 'personal',
  );

  final String id;

  /// `null` = bugetul general al gospodăriei.
  final String? categoryId;
  final Currency currency;
  final int amountMinor;
  final int spentMinor;

  /// Poate fi negativ (buget depășit).
  final int remainingMinor;

  /// `floor(cheltuit × 100 / buget)`; semaforul se decide pe server, pe comparații exacte.
  final int percent;
  final BudgetLight status;
  final bool personal;
}

class BudgetsStatus {
  const BudgetsStatus({required this.month, required this.items});

  factory BudgetsStatus.fromJson(JsonMap j) {
    final month = YearMonth.tryParse(Json.str(j, 'month'));
    if (month == null) throw const FormatException('Lună invalidă');
    return BudgetsStatus(
      month: month,
      items: [
        for (final b in Json.list(j['data'])) BudgetStatusItem.fromJson(b),
      ],
    );
  }

  final YearMonth month;
  final List<BudgetStatusItem> items;
}

enum GoalStatus {
  active('active', 'Activ'),
  achieved('achieved', 'Atins'),
  abandoned('abandoned', 'Abandonat');

  const GoalStatus(this.api, this.label);
  final String api;
  final String label;

  static GoalStatus parse(String value) => GoalStatus.values.firstWhere(
    (s) => s.api == value,
    orElse: () =>
        throw FormatException('Stare de obiectiv necunoscută: $value'),
  );
}

class Goal {
  const Goal({
    required this.id,
    required this.name,
    required this.targetMinor,
    required this.savedMinor,
    required this.currency,
    required this.status,
    required this.progressPct,
    this.deadline,
  });

  factory Goal.fromJson(JsonMap j) {
    final deadline = Json.strOrNull(j, 'deadline');
    return Goal(
      id: Json.str(j, 'id'),
      name: Json.str(j, 'name'),
      targetMinor: Json.integer(j, 'targetMinor'),
      savedMinor: Json.integer(j, 'savedMinor'),
      currency: Json.currency(j, 'currency'),
      status: GoalStatus.parse(Json.str(j, 'status')),
      progressPct: Json.integer(j, 'progressPct'),
      deadline: deadline == null ? null : parseApiDate(deadline),
    );
  }

  final String id;
  final String name;
  final int targetMinor;
  final int savedMinor;
  final Currency currency;
  final GoalStatus status;
  final int progressPct;
  final DateTime? deadline;
}

class ReportCategory {
  const ReportCategory({
    required this.name,
    required this.amountMinor,
    required this.count,
    required this.percent,
  });

  factory ReportCategory.fromJson(JsonMap j) => ReportCategory(
    name: Json.strOrNull(j, 'name') ?? 'Fără categorie',
    amountMinor: Json.integer(j, 'amountMinor'),
    count: Json.integer(j, 'count'),
    percent: Json.integerOrNull(j, 'percent') ?? 0,
  );

  final String name;
  final int amountMinor;
  final int count;
  final int percent;
}

class ReportMerchant {
  const ReportMerchant({
    required this.merchant,
    required this.amountMinor,
    required this.count,
  });

  factory ReportMerchant.fromJson(JsonMap j) => ReportMerchant(
    merchant: Json.str(j, 'merchant'),
    amountMinor: Json.integer(j, 'amountMinor'),
    count: Json.integer(j, 'count'),
  );

  final String merchant;
  final int amountMinor;
  final int count;
}

class CurrencyReport {
  const CurrencyReport({
    required this.currency,
    required this.totals,
    required this.byCategory,
    required this.topMerchants,
  });

  factory CurrencyReport.fromJson(JsonMap j) => CurrencyReport(
    currency: Json.currency(j, 'currency'),
    totals: PeriodTotals.fromJson(Json.map(j['totals'])),
    byCategory: [
      for (final c in Json.list(j['byCategory'])) ReportCategory.fromJson(c),
    ],
    topMerchants: [
      for (final m in Json.list(j['topMerchants'])) ReportMerchant.fromJson(m),
    ],
  );

  final Currency currency;
  final PeriodTotals totals;
  final List<ReportCategory> byCategory;
  final List<ReportMerchant> topMerchants;
}

class MonthlyReportData {
  const MonthlyReportData({required this.month, required this.currencies});

  factory MonthlyReportData.fromJson(JsonMap j) {
    final month = YearMonth.tryParse(Json.str(j, 'month'));
    if (month == null) throw const FormatException('Lună invalidă');
    return MonthlyReportData(
      month: month,
      currencies: [
        for (final c in Json.list(j['currencies'])) CurrencyReport.fromJson(c),
      ],
    );
  }

  final YearMonth month;
  final List<CurrencyReport> currencies;
}
