import '../../core/money/money.dart';
import '../../core/time/period.dart';
import '../finance/models.dart';

/// Modelele recurențelor (Faza D), după `docs/openapi.json`. Clientul nu calculează scadențe:
/// `nextRunOn`, `due` și contoarele vin de la server.

enum RecurringStatus {
  active('active', 'Activă'),
  paused('paused', 'Pe pauză'),
  completed('completed', 'Încheiată');

  const RecurringStatus(this.api, this.label);
  final String api;
  final String label;

  static RecurringStatus parse(String value) =>
      RecurringStatus.values.firstWhere(
        (s) => s.api == value,
        orElse: () => throw FormatException('Stare necunoscută: $value'),
      );
}

enum Frequency {
  daily('daily', 'zilnic', 'zile'),
  weekly('weekly', 'săptămânal', 'săptămâni'),
  monthly('monthly', 'lunar', 'luni'),
  yearly('yearly', 'anual', 'ani');

  const Frequency(this.api, this.label, this.unit);
  final String api;
  final String label;

  /// Unitatea la plural, pentru „la fiecare N luni”.
  final String unit;

  static Frequency parse(String value) => Frequency.values.firstWhere(
    (f) => f.api == value,
    orElse: () => throw FormatException('Frecvență necunoscută: $value'),
  );
}

DateTime _date(JsonMap m, String key) {
  final d = parseApiDate(Json.str(m, key));
  if (d == null) throw FormatException('Dată invalidă: $key');
  return d;
}

DateTime? _dateOrNull(JsonMap m, String key) =>
    m[key] == null ? null : _date(m, key);

class RecurringRule {
  const RecurringRule({
    required this.id,
    required this.accountId,
    required this.categoryId,
    required this.type,
    required this.amount,
    required this.description,
    required this.merchant,
    required this.frequency,
    required this.interval,
    required this.nextRunOn,
    required this.endOn,
    required this.maxOccurrences,
    required this.occurrencesCount,
    required this.status,
    required this.due,
    required this.lastErrorCode,
  });

  factory RecurringRule.fromJson(JsonMap m) => RecurringRule(
    id: Json.str(m, 'id'),
    accountId: Json.str(m, 'accountId'),
    categoryId: Json.strOrNull(m, 'categoryId'),
    type: TxType.parse(Json.str(m, 'type')),
    amount: Money(Json.integer(m, 'amountMinor'), Json.currency(m, 'currency')),
    description: Json.str(m, 'description'),
    merchant: Json.strOrNull(m, 'merchant'),
    frequency: Frequency.parse(Json.str(m, 'frequency')),
    interval: Json.integer(m, 'interval'),
    nextRunOn: _date(m, 'nextRunOn'),
    endOn: _dateOrNull(m, 'endOn'),
    maxOccurrences: Json.integerOrNull(m, 'maxOccurrences'),
    occurrencesCount: Json.integer(m, 'occurrencesCount'),
    status: RecurringStatus.parse(Json.str(m, 'status')),
    due: Json.boolean(m, 'due'),
    lastErrorCode: Json.strOrNull(m, 'lastErrorCode'),
  );

  final String id;
  final String accountId;
  final String? categoryId;
  final TxType type;
  final Money amount;
  final String description;
  final String? merchant;
  final Frequency frequency;
  final int interval;
  final DateTime nextRunOn;
  final DateTime? endOn;
  final int? maxOccurrences;
  final int occurrencesCount;
  final RecurringStatus status;

  /// Scadentă acum, decis de server.
  final bool due;
  final String? lastErrorCode;

  /// „lunar” sau „la fiecare 2 luni”.
  String get frequencyLabel => interval == 1
      ? frequency.label
      : 'la fiecare $interval ${frequency.unit}';
}

class RecurringCounts {
  const RecurringCounts({
    required this.active,
    required this.due,
    required this.total,
  });

  factory RecurringCounts.fromJson(JsonMap m) => RecurringCounts(
    active: Json.integer(m, 'active'),
    due: Json.integer(m, 'due'),
    total: Json.integer(m, 'total'),
  );

  final int active;
  final int due;
  final int total;
}

class RecurringList {
  const RecurringList({required this.rules, required this.counts});

  final List<RecurringRule> rules;
  final RecurringCounts counts;
}

class RecurringSuggestion {
  const RecurringSuggestion({
    required this.signature,
    required this.accountName,
    required this.type,
    required this.amount,
    required this.description,
    required this.merchant,
    required this.frequency,
    required this.occurrences,
    required this.nextOn,
  });

  factory RecurringSuggestion.fromJson(JsonMap m) => RecurringSuggestion(
    signature: Json.str(m, 'signature'),
    accountName: Json.str(m, 'accountName'),
    type: TxType.parse(Json.str(m, 'type')),
    amount: Money(Json.integer(m, 'amountMinor'), Json.currency(m, 'currency')),
    description: Json.str(m, 'description'),
    merchant: Json.strOrNull(m, 'merchant'),
    frequency: Frequency.parse(Json.str(m, 'frequency')),
    occurrences: Json.integer(m, 'occurrences'),
    nextOn: _date(m, 'nextOn'),
  );

  final String signature;
  final String accountName;
  final TxType type;
  final Money amount;
  final String description;
  final String? merchant;
  final Frequency frequency;
  final int occurrences;
  final DateTime nextOn;
}

/// Rezultatul „Generează acum”, așa cum îl numără serverul.
class GenerateResult {
  const GenerateResult({
    required this.rules,
    required this.generated,
    required this.failed,
    required this.skipped,
  });

  factory GenerateResult.fromJson(JsonMap m) => GenerateResult(
    rules: Json.integer(m, 'rules'),
    generated: Json.integer(m, 'generated'),
    failed: Json.integer(m, 'failed'),
    skipped: Json.integer(m, 'skipped'),
  );

  final int rules;
  final int generated;
  final int failed;
  final int skipped;
}
