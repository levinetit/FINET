import 'package:flutter/material.dart';

import '../../core/data/mock_data.dart';
import '../../core/money/format.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';

/// Tranzacții: lista lunii. Faza A: date simulate; lista paginată, filtrele și adăugarea reală
/// vin în Faza C (`GET/POST /api/v1/transactions`).
class TransactionsScreen extends StatelessWidget {
  const TransactionsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final items = mockTransactions;
    final text = Theme.of(context).textTheme;
    return FinetScaffold(
      title: 'Tranzacții',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Adăugarea tranzacțiilor vine în Faza C.'),
          ),
        ),
        icon: const Icon(Icons.add),
        label: const Text('Adaugă'),
      ),
      body: items.isEmpty
          ? const EmptyState(
              title: 'Nu ai încă tranzacții',
              message: 'Adaugă prima tranzacție sau scanează un bon.',
            )
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
              itemCount: items.length,
              separatorBuilder: (_, _) => const Divider(),
              itemBuilder: (context, i) {
                final t = items[i];
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(t.description, style: text.bodyLarge),
                            const SizedBox(height: 2),
                            Text(
                              '${t.category} · ${formatDate(t.date)}',
                              style: text.bodySmall?.copyWith(
                                color: context.finet.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      AmountText(t.amount, signed: true, bold: true),
                    ],
                  ),
                );
              },
            ),
    );
  }
}
