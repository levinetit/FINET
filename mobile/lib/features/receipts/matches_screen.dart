import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money/format.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';
import 'match_panel.dart';
import 'models.dart';
import 'providers.dart';

/// Coada potrivirilor bon ↔ extras: bonurile pentru care există o tranzacție din extras cu
/// aceeași sumă, la cel mult 3 zile.
class MatchesScreen extends ConsumerWidget {
  const MatchesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final queue = ref.watch(matchQueueProvider);
    return FinetScaffold(
      title: 'Potriviri cu extrasul',
      body: AsyncView<List<ReceiptMatches>>(
        value: queue,
        onRetry: () => ref.invalidate(matchQueueProvider),
        data: (items) => items.isEmpty
            ? const EmptyState(title: 'Nu ai potriviri de verificat.')
            : RefreshIndicator(
                onRefresh: () async {
                  ref.invalidate(matchQueueProvider);
                  await ref.read(matchQueueProvider.future);
                },
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    for (final m in items) ...[
                      InkWell(
                        onTap: () => context.push('/receipts/${m.receiptId}'),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: Text(
                            '${m.merchantName ?? 'Magazin necunoscut'} · ${formatDate(m.occurredOn)}',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ),
                      ),
                      MatchPanel(matches: m),
                      const Divider(height: 32),
                    ],
                  ],
                ),
              ),
      ),
    );
  }
}
