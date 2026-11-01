import 'package:flutter/material.dart';

import '../../core/data/mock_data.dart';
import '../../core/money/format.dart';
import '../../core/money/money.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/finet_scaffold.dart';

/// Acasă: sumarul lunii (venituri, cheltuieli, sold net, număr de tranzacții, categorii).
/// Faza A: date simulate; cifrele reale vin de la `GET /api/v1/dashboard` în Faza C.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = mockSummary;
    final text = Theme.of(context).textTheme;
    final c = context.finet;
    final maxCategory = s.categories.fold<int>(
      1,
      (m, e) => e.amount.amountMinor > m ? e.amount.amountMinor : m,
    );
    return FinetScaffold(
      title: 'Acasă',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            formatMonth(s.month),
            style: text.bodyMedium?.copyWith(color: c.muted),
          ),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Sold net',
                    style: text.labelMedium?.copyWith(color: c.muted),
                  ),
                  const SizedBox(height: 4),
                  AmountText(s.net, size: 28, bold: true, signed: true),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _Figure(
                          label: 'Venituri',
                          money: s.income,
                          signed: true,
                        ),
                      ),
                      Expanded(
                        child: _Figure(
                          label: 'Cheltuieli',
                          money: -s.expenses,
                          signed: true,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '${s.transactionCount} tranzacții în această lună',
                    style: text.bodySmall?.copyWith(color: c.muted),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text('Cheltuieli pe categorii', style: text.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  for (final cat in s.categories) ...[
                    _CategoryBar(
                      name: cat.name,
                      amount: cat.amount,
                      fraction: cat.amount.amountMinor / maxCategory,
                    ),
                    if (cat != s.categories.last) const SizedBox(height: 12),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({
    required this.label,
    required this.money,
    this.signed = false,
  });
  final String label;
  final Money money;
  final bool signed;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium
              ?.copyWith(color: context.finet.muted),
        ),
        const SizedBox(height: 2),
        AmountText(money, signed: signed, bold: true),
      ],
    );
  }
}

class _CategoryBar extends StatelessWidget {
  const _CategoryBar({
    required this.name,
    required this.amount,
    required this.fraction,
  });
  final String name;
  final Money amount;
  final double fraction;

  @override
  Widget build(BuildContext context) {
    final c = context.finet;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(name, style: Theme.of(context).textTheme.bodyMedium),
            ),
            AmountText(amount, size: 14),
          ],
        ),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: fraction.clamp(0.0, 1.0),
            minHeight: 6,
            backgroundColor: c.line,
            color: c.accent,
            semanticsLabel: name,
          ),
        ),
      ],
    );
  }
}
