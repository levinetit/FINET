import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money/format.dart';
import '../../core/state/privacy.dart';
import '../../core/theme/theme.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';
import '../usage/usage_tracker.dart';
import 'models.dart';
import 'providers.dart';

/// Bonurile gospodăriei, cele mai noi primele, cu filtru pe stare. „De verificat” e filtrul
/// implicit: acolo așteaptă bonurile citite de server.
class ReceiptsScreen extends ConsumerWidget {
  const ReceiptsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(receiptsControllerProvider);
    final controller = ref.read(receiptsControllerProvider.notifier);
    final c = context.finet;
    return FinetScaffold(
      title: 'Bonuri',
      screen: UsageScreens.receipts,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Wrap(
              spacing: 8,
              children: [
                for (final s in const [
                  ReceiptStatus.needsReview,
                  ReceiptStatus.saved,
                  ReceiptStatus.queued,
                  ReceiptStatus.failed,
                ])
                  ChoiceChip(
                    label: Text(s.label),
                    selected: state.status == s,
                    onSelected: (_) => controller.setStatus(s),
                  ),
                ChoiceChip(
                  label: const Text('Toate'),
                  selected: state.status == null,
                  onSelected: (_) => controller.setStatus(null),
                ),
              ],
            ),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => context.push('/matches'),
              icon: const Icon(Icons.link),
              label: const Text('Potriviri cu extrasul'),
            ),
          ),
          Expanded(
            child: state.loading && state.items.isEmpty
                ? const LoadingState()
                : state.error != null && state.items.isEmpty
                ? ErrorState(
                    message: state.error!.message,
                    onRetry: controller.refresh,
                  )
                : state.items.isEmpty
                ? const EmptyState(
                    title: 'Niciun bon aici',
                    message: 'Fotografiază un bon din „Scanează”; după citire apare aici.',
                  )
                : RefreshIndicator(
                    onRefresh: controller.refresh,
                    child: NotificationListener<ScrollNotification>(
                      onNotification: (n) {
                        if (n.metrics.pixels >=
                            n.metrics.maxScrollExtent - 200) {
                          controller.loadMore();
                        }
                        return false;
                      },
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: state.items.length + (state.hasMore ? 1 : 0),
                        itemBuilder: (context, i) {
                          if (i >= state.items.length) {
                            return const Padding(
                              padding: EdgeInsets.all(16),
                              child: Center(child: CircularProgressIndicator()),
                            );
                          }
                          return _ReceiptTile(
                            receipt: state.items[i],
                            muted: c.muted,
                          );
                        },
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _ReceiptTile extends ConsumerWidget {
  const _ReceiptTile({required this.receipt, required this.muted});

  final Receipt receipt;
  final Color muted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hidden = ref.watch(hideAmountsProvider);
    final total = receipt.total;
    final date = receipt.occurredOn;
    final amount = total == null ? '—' : displayMoney(total, hidden: hidden);
    return Card(
      child: ListTile(
        title: Text(receipt.merchantName ?? 'Magazin necunoscut'),
        subtitle: Text(
          '${date == null ? 'fără dată' : formatDate(date)} · ${receipt.status.label}'
          '${receipt.issues.isEmpty ? '' : ' · ${receipt.issues.length} probleme'}',
          style: TextStyle(color: muted),
        ),
        trailing: Text(amount, style: amountStyle(15, bold: true)),
        onTap: () => context.push('/receipts/${receipt.id}'),
      ),
    );
  }
}
