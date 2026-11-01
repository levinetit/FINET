import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import 'models.dart';
import 'recurring_api.dart';

final recurringApiProvider = Provider<RecurringApi>(
  (ref) => RecurringApi(ref.watch(dioProvider)),
);

/// Toate regulile gospodăriei plus contoarele calculate de server. Filtrul pe stare e doar de
/// afișare, deci se aplică în ecran.
final recurringListProvider = FutureProvider.autoDispose<RecurringList>(
  (ref) => ref.watch(recurringApiProvider).list(),
);

final recurringSuggestionsProvider =
    FutureProvider.autoDispose<List<RecurringSuggestion>>(
      (ref) => ref.watch(recurringApiProvider).suggestions(),
    );
