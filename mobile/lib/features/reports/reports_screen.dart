import 'package:flutter/material.dart';

import '../../core/data/mock_data.dart';
import '../../core/money/format.dart';
import '../../core/money/money.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/finet_scaffold.dart';

/// Rapoarte: raportul lunar. Faza A: date simulate; rapoartele reale vin din
/// `GET /api/v1/reports/monthly` în Faza C.
class ReportsScreen extends StatelessWidget {
  const ReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = mockSummary;
    final text = Theme.of(context).textTheme;
    final total = Money.sum(s.categories.map((e) => e.amount), Currency.ron);
    return FinetScaffold(
      title: 'Rapoarte',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Raport lunar', style: text.titleMedium),
          const SizedBox(height: 2),
          Text(
            formatMonth(s.month),
            style: text.bodyMedium?.copyWith(color: context.finet.muted),
          ),
          const SizedBox(height: 12),
          Card(
            child: Column(
              children: [
                for (final cat in s.categories) ...[
                  ListTile(
                    title: Text(cat.name),
                    trailing: AmountText(cat.amount),
                  ),
                  const Divider(),
                ],
                ListTile(
                  title: Text('Total cheltuieli', style: text.titleSmall),
                  trailing: AmountText(total, bold: true),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
