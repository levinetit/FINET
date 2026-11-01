import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_error.dart';
import '../scan/providers.dart';
import '../../core/providers.dart';
import 'models.dart';

/// Un bon cu liniile lui, de la server.
final receiptDetailProvider = FutureProvider.autoDispose
    .family<Receipt, String>(
      (ref, id) => ref.watch(receiptsApiProvider).receipt(id),
    );

/// Propunerile de potrivire ale unui bon (`null` = niciuna).
final receiptMatchesProvider = FutureProvider.autoDispose
    .family<ReceiptMatches?, String>(
      (ref, id) => ref.watch(receiptsApiProvider).matches(id),
    );

/// Coada globală a potrivirilor bon ↔ extras.
final matchQueueProvider = FutureProvider.autoDispose<List<ReceiptMatches>>(
  (ref) => ref.watch(receiptsApiProvider).matchQueue(),
);

class ReceiptsState {
  const ReceiptsState({
    this.status = ReceiptStatus.needsReview,
    this.items = const [],
    this.nextCursor,
    this.loading = true,
    this.loadingMore = false,
    this.error,
  });

  /// `null` = toate.
  final ReceiptStatus? status;
  final List<Receipt> items;
  final String? nextCursor;
  final bool loading;
  final bool loadingMore;
  final ApiError? error;

  bool get hasMore => nextCursor != null;

  ReceiptsState copyWith({
    ReceiptStatus? Function()? status,
    List<Receipt>? items,
    String? Function()? nextCursor,
    bool? loading,
    bool? loadingMore,
    ApiError? Function()? error,
  }) => ReceiptsState(
    status: status != null ? status() : this.status,
    items: items ?? this.items,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    error: error != null ? error() : this.error,
  );
}

/// Lista bonurilor: filtru pe stare, pagini cu cursor, reîmprospătare.
class ReceiptsController extends Notifier<ReceiptsState> {
  int _generation = 0;

  @override
  ReceiptsState build() {
    Future<void>.microtask(refresh);
    return const ReceiptsState();
  }

  Future<void> setStatus(ReceiptStatus? status) async {
    state = state.copyWith(status: () => status);
    await refresh();
  }

  Future<void> refresh() async {
    final generation = ++_generation;
    state = state.copyWith(loading: true, error: () => null);
    try {
      final page = await ref
          .read(receiptsApiProvider)
          .receipts(status: state.status);
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

  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loading || state.loadingMore) return;
    final generation = _generation;
    state = state.copyWith(loadingMore: true, error: () => null);
    try {
      final page = await ref
          .read(receiptsApiProvider)
          .receipts(status: state.status, cursor: cursor);
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

final receiptsControllerProvider =
    NotifierProvider<ReceiptsController, ReceiptsState>(ReceiptsController.new);

/// Textul unei raportări de potrivire, ca pe web.
const Map<String, String> matchReasonText = {
  'amount_exact': 'aceeași sumă',
  'date_same_day': 'aceeași zi',
  'date_diff_1': 'la 1 zi',
  'date_diff_2': 'la 2 zile',
  'date_diff_3': 'la 3 zile',
  'merchant_tax_id': 'CUI-ul comerciantului apare în extras',
  'merchant_name': 'numele comerciantului apare în extras',
  'merchant_partial': 'o parte din numele comerciantului apare în extras',
  'merchant_unknown': 'comerciantul nu se recunoaște',
};
