import 'package:dio/dio.dart';

import '../../core/money/money.dart';
import '../../core/network/api_client.dart';
import '../../core/time/period.dart';
import 'models.dart';

/// O tranzacție în curs de creare sau editare (venit sau cheltuială).
class TransactionDraft {
  const TransactionDraft({
    required this.accountId,
    required this.type,
    required this.amount,
    required this.occurredOn,
    this.categoryId,
    this.description,
    this.merchant,
    this.notes,
    this.tagIds = const [],
  });

  final String accountId;

  /// `income` sau `expense` (transferurile nu se creează de aici).
  final TxType type;

  /// Pozitivă; moneda e a contului.
  final Money amount;
  final DateTime occurredOn;
  final String? categoryId;
  final String? description;
  final String? merchant;
  final String? notes;
  final List<String> tagIds;

  static String? _blankToNull(String? v) {
    final t = v?.trim();
    return (t == null || t.isEmpty) ? null : t;
  }

  /// Corpul cererii: suma ca `amountMinor` întreg (nu text), câmpurile goale ca `null`.
  Map<String, Object?> toJson() => {
    'accountId': accountId,
    'type': type.api,
    'amountMinor': amount.amountMinor,
    'occurredOn': apiDate(occurredOn),
    'categoryId': categoryId,
    'description': _blankToNull(description),
    'merchant': _blankToNull(merchant),
    'notes': _blankToNull(notes),
    'tagIds': tagIds,
  };
}

/// Apelurile financiare către FINET (Faza C). Toate aruncă `ApiError`. Clientul nu calculează
/// sume: afișează ce întoarce serverul.
class FinanceApi {
  FinanceApi(this._dio);

  final Dio _dio;

  Future<JsonMap> _get(String path, {Map<String, Object?>? query}) async {
    final r = await guardApi(
      () => _dio.get<dynamic>(path, queryParameters: query),
    );
    return parseBody(() => Json.map(r.data));
  }

  Future<DashboardData> dashboard(YearMonth month) async {
    final body = await _get('/api/v1/dashboard', query: {'month': month.api});
    return parseBody(() => DashboardData.fromJson(Json.map(body['data'])));
  }

  Future<AccountsResult> accounts() async {
    final body = await _get('/api/v1/accounts');
    return parseBody(() => AccountsResult.fromJson(body));
  }

  Future<List<Category>> categories() async {
    final body = await _get('/api/v1/categories');
    return parseBody(
      () => [for (final c in Json.list(body['data'])) Category.fromJson(c)],
    );
  }

  Future<List<Tag>> tags() async {
    final body = await _get('/api/v1/tags');
    return parseBody(
      () => [for (final t in Json.list(body['data'])) Tag.fromJson(t)],
    );
  }

  Future<TransactionPage> transactions(
    TransactionFilters filters, {
    String? cursor,
    int limit = 30,
  }) async {
    final body = await _get(
      '/api/v1/transactions',
      query: {...filters.toQuery(), 'limit': '$limit', 'cursor': ?cursor},
    );
    return parseBody(() => TransactionPage.fromJson(body));
  }

  /// Creează o tranzacție. [idempotencyKey] se generează o singură dată per acțiune a
  /// utilizatorului și se păstrează la reîncercări: o tranzacție trimisă de două ori cu aceeași
  /// cheie apare o singură dată.
  Future<FinTransaction> createTransaction(
    TransactionDraft draft, {
    required String idempotencyKey,
  }) async {
    final r = await guardApi(
      () => _dio.post<dynamic>(
        '/api/v1/transactions',
        data: draft.toJson(),
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
    return parseBody(
      () => FinTransaction.fromJson(Json.map(Json.map(r.data)['data'])),
    );
  }

  Future<FinTransaction> updateTransaction(
    String id,
    TransactionDraft draft,
  ) async {
    final r = await guardApi(
      () =>
          _dio.patch<dynamic>('/api/v1/transactions/$id', data: draft.toJson()),
    );
    return parseBody(
      () => FinTransaction.fromJson(Json.map(Json.map(r.data)['data'])),
    );
  }

  Future<void> deleteTransaction(String id) async {
    await guardApi(() => _dio.delete<dynamic>('/api/v1/transactions/$id'));
  }

  Future<BudgetsStatus> budgets(YearMonth month) async {
    final body = await _get(
      '/api/v1/budgets/status',
      query: {'month': month.api},
    );
    return parseBody(() => BudgetsStatus.fromJson(body));
  }

  Future<List<Goal>> goals() async {
    final body = await _get('/api/v1/goals');
    return parseBody(
      () => [for (final g in Json.list(body['data'])) Goal.fromJson(g)],
    );
  }

  /// O contribuție (`add`) sau o retragere (`withdraw`). Cheia de idempotență e OBLIGATORIE pe
  /// server: o reîncercare fără cheie ar dubla suma economisită.
  Future<Goal> goalContribution(
    String goalId, {
    required bool add,
    required Money amount,
    required String idempotencyKey,
  }) async {
    final r = await guardApi(
      () => _dio.post<dynamic>(
        '/api/v1/goals/$goalId/contributions',
        data: {
          'direction': add ? 'add' : 'withdraw',
          'amountMinor': amount.amountMinor,
        },
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
    return parseBody(() => Goal.fromJson(Json.map(Json.map(r.data)['data'])));
  }

  Future<MonthlyReportData> monthlyReport(YearMonth month) async {
    final body = await _get(
      '/api/v1/reports/monthly',
      query: {'month': month.api},
    );
    return parseBody(() => MonthlyReportData.fromJson(Json.map(body['data'])));
  }
}
