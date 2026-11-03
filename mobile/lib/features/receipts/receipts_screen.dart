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
import 'receipt_delete.dart';

/// Bonurile gospodăriei, cele mai noi primele, cu filtru pe stare. „De verificat” e filtrul
/// implicit: acolo așteaptă bonurile citite de server.
class ReceiptsScreen extends ConsumerWidget {
  const ReceiptsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(receiptsControllerProvider);
    final controller = ref.read(receiptsControllerProvider.notifier);
    final c = context.finet;
    // Filtrele și linkul stau ÎN lista derulabilă (primul element): la text mărit ocupă mult loc
    // și, ținute deasupra listei, lăsau bonurilor doar o fâșie de ecran.
    final header = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
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
        TextButton.icon(
          onPressed: () => context.push('/matches'),
          icon: const Icon(Icons.link),
          label: const Text('Potriviri cu extrasul'),
        ),
      ],
    );
    final Widget body;
    if (state.loading && state.items.isEmpty) {
      body = ListView(
        children: [
          header,
          const SizedBox(height: 240, child: LoadingState()),
        ],
      );
    } else if (state.error != null && state.items.isEmpty) {
      body = ListView(
        children: [
          header,
          SizedBox(
            height: 320,
            child: ErrorState(
              message: state.error!.message,
              onRetry: controller.refresh,
            ),
          ),
        ],
      );
    } else if (state.items.isEmpty) {
      body = ListView(
        children: [
          header,
          const SizedBox(
            height: 320,
            child: EmptyState(
              title: 'Niciun bon aici',
              message:
                  'Fotografiază un bon din „Scanează”; după citire apare aici.',
            ),
          ),
        ],
      );
    } else {
      body = RefreshIndicator(
        onRefresh: controller.refresh,
        child: NotificationListener<ScrollNotification>(
          onNotification: (n) {
            if (n.metrics.pixels >= n.metrics.maxScrollExtent - 200) {
              controller.loadMore();
            }
            return false;
          },
          child: ListView.builder(
            itemCount: 1 + state.items.length + (state.hasMore ? 1 : 0),
            itemBuilder: (context, i) {
              if (i == 0) return header;
              final index = i - 1;
              if (index >= state.items.length) {
                return const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: _ReceiptTile(
                  receipt: state.items[index],
                  muted: c.muted,
                ),
              );
            },
          ),
        ),
      );
    }
    return FinetScaffold(
      title: 'Bonuri',
      screen: UsageScreens.receipts,
      body: body,
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
    // Rând construit cu `Row`, nu cu `ListTile`: la text mărit (2.0) un `trailing` lat ar umple
    // tot rândul și ar da eroare de aranjare; aici titlul se strânge și suma rămâne întreagă.
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => context.push('/receipts/${receipt.id}'),
        child: Padding(
          padding: const EdgeInsets.only(left: 16, top: 8, bottom: 8),
          child: Row(
            children: [
              Expanded(
                flex: 3,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      receipt.merchantName ?? 'Magazin necunoscut',
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                    Text(
                      '${date == null ? 'fără dată' : formatDate(date)} · ${receipt.status.label}'
                      '${receipt.issues.isEmpty ? '' : ' · ${receipt.issues.length} probleme'}',
                      style: TextStyle(color: muted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                flex: 2,
                child: Text(
                  amount,
                  textAlign: TextAlign.end,
                  style: amountStyle(15, bold: true),
                ),
              ),
              PopupMenuButton<String>(
                tooltip: 'Mai multe',
                onSelected: (_) =>
                    confirmAndDeleteReceipt(context, ref, receipt.id),
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'delete', child: Text('Șterge bonul')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
