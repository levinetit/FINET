import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderOrFamily;

import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/time/period.dart';
import '../auth/session.dart';
import '../lock/app_lock.dart';
import '../usage/usage_tracker.dart';
import 'finance_api.dart';
import 'models.dart';

final financeApiProvider = Provider<FinanceApi>(
  (ref) => FinanceApi(ref.watch(dioProvider)),
);

/// Fusul orar al gospodăriei din sesiune (implicit `Europe/Bucharest`).
String timezoneOf(SessionState session) => session is SignedIn
    ? (session.profile.household?.timezone ?? 'Europe/Bucharest')
    : 'Europe/Bucharest';

/// Ziua de azi în fusul gospodăriei (ceasul vine din [clockProvider], înlocuibil în teste).
DateTime todayFor(Ref ref) =>
    todayIn(ref.read(clockProvider)(), timezoneOf(ref.read(sessionProvider)));

/// Luna afișată pe Acasă, Bugete și Rapoarte. API-ul acceptă luna curentă și până la 60 de luni
/// în urmă.
final selectedMonthProvider = NotifierProvider<SelectedMonth, YearMonth>(
  SelectedMonth.new,
);

class SelectedMonth extends Notifier<YearMonth> {
  static const maxMonthsBack = 60;

  YearMonth get _current => YearMonth.fromDate(todayFor(ref));

  @override
  YearMonth build() => YearMonth.fromDate(todayFor(ref));

  bool get canGoNext => state < _current;

  bool get canGoPrevious {
    var limit = _current;
    for (var i = 0; i < maxMonthsBack; i++) {
      limit = limit.previous;
    }
    return state > limit;
  }

  void previous() {
    if (canGoPrevious) state = state.previous;
  }

  void next() {
    if (canGoNext) state = state.next;
  }
}

final dashboardProvider = FutureProvider.autoDispose
    .family<DashboardData, YearMonth>((ref, month) async {
      final data = await ref.watch(financeApiProvider).dashboard(month);
      ref.read(usageTrackerProvider).track(UsageEvents.dashboardViewed);
      return data;
    });

final accountsProvider = FutureProvider.autoDispose<AccountsResult>(
  (ref) => ref.watch(financeApiProvider).accounts(),
);

final categoriesProvider = FutureProvider.autoDispose<List<Category>>(
  (ref) => ref.watch(financeApiProvider).categories(),
);

final tagsProvider = FutureProvider.autoDispose<List<Tag>>(
  (ref) => ref.watch(financeApiProvider).tags(),
);

final budgetsProvider = FutureProvider.autoDispose
    .family<BudgetsStatus, YearMonth>(
      (ref, month) => ref.watch(financeApiProvider).budgets(month),
    );

final goalsProvider = FutureProvider.autoDispose<List<Goal>>(
  (ref) => ref.watch(financeApiProvider).goals(),
);

final reportProvider = FutureProvider.autoDispose
    .family<MonthlyReportData, YearMonth>((ref, month) async {
      final data = await ref.watch(financeApiProvider).monthlyReport(month);
      ref.read(usageTrackerProvider).track(UsageEvents.reportViewed);
      return data;
    });

/// După orice scriere (tranzacție, contribuție) cifrele din dashboard, conturi, bugete și
/// rapoarte sunt vechi: se cer din nou de la server (clientul nu le recalculează).
///
/// Primește `ref.invalidate` (merge și cu `Ref`, și cu `WidgetRef`).
void invalidateFinance(void Function(ProviderOrFamily provider) invalidate) {
  invalidate(dashboardProvider);
  invalidate(accountsProvider);
  invalidate(budgetsProvider);
  invalidate(goalsProvider);
  invalidate(reportProvider);
}

/// Starea listei de tranzacții: pagini încărcate cu cursor, filtre, încărcare, eroare.
class TransactionsState {
  const TransactionsState({
    this.items = const [],
    this.filters = const TransactionFilters(),
    this.nextCursor,
    this.loading = true,
    this.loadingMore = false,
    this.error,
  });

  final List<FinTransaction> items;
  final TransactionFilters filters;
  final String? nextCursor;

  /// Prima încărcare sau reîmprospătare completă.
  final bool loading;
  final bool loadingMore;
  final ApiError? error;

  bool get hasMore => nextCursor != null;

  TransactionsState copyWith({
    List<FinTransaction>? items,
    TransactionFilters? filters,
    String? Function()? nextCursor,
    bool? loading,
    bool? loadingMore,
    ApiError? Function()? error,
  }) => TransactionsState(
    items: items ?? this.items,
    filters: filters ?? this.filters,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    error: error != null ? error() : this.error,
  );
}

final transactionsProvider =
    NotifierProvider<TransactionsController, TransactionsState>(
      TransactionsController.new,
    );

class TransactionsController extends Notifier<TransactionsState> {
  /// Fiecare reîmprospătare are un număr; un răspuns întârziat al unei liste vechi (alte filtre)
  /// nu o înlocuiește pe cea nouă.
  int _generation = 0;

  @override
  TransactionsState build() {
    Future<void>.microtask(refresh);
    return const TransactionsState();
  }

  Future<void> setFilters(TransactionFilters filters) async {
    state = state.copyWith(filters: filters);
    await refresh();
  }

  /// Reîncarcă de la prima pagină, cu filtrele curente.
  Future<void> refresh() async {
    final generation = ++_generation;
    state = state.copyWith(loading: true, error: () => null);
    try {
      final page = await ref
          .read(financeApiProvider)
          .transactions(state.filters);
      if (generation != _generation) return;
      state = state.copyWith(
        items: page.items,
        nextCursor: () => page.nextCursor,
        loading: false,
      );
    } on ApiError catch (e) {
      if (generation != _generation) return;
      ref.read(usageTrackerProvider).error(e);
      state = state.copyWith(loading: false, error: () => e);
    }
  }

  /// Încarcă pagina următoare (la capătul listei).
  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loading || state.loadingMore) return;
    final generation = _generation;
    state = state.copyWith(loadingMore: true, error: () => null);
    try {
      final page = await ref
          .read(financeApiProvider)
          .transactions(state.filters, cursor: cursor);
      if (generation != _generation) return;
      state = state.copyWith(
        items: [...state.items, ...page.items],
        nextCursor: () => page.nextCursor,
        loadingMore: false,
      );
    } on ApiError catch (e) {
      if (generation != _generation) return;
      state = state.copyWith(loadingMore: false, error: () => e);
    }
  }
}
