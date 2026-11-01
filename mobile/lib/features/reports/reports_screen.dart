import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money/money.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/month_selector.dart';
import '../../core/widgets/states.dart';
import '../finance/models.dart';
import '../finance/providers.dart';

/// Rapoarte: raportul lunar (`GET /api/v1/reports/monthly`), pe monedă: totaluri, categorii,
/// comercianți. Cifrele sunt ale serverului.
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final month = ref.watch(selectedMonthProvider);
    final report = ref.watch(reportProvider(month));
    return FinetScaffold(
      title: 'Rapoarte',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const MonthSelector(),
          AsyncView<MonthlyReportData>(
            value: report,
            onRetry: () => ref.invalidate(reportProvider),
            data: (r) {
              if (r.currencies.isEmpty) {
                return const EmptyState(
                  title: 'Nicio tranzacție în această lună',
                );
              }
              return Column(
                children: [
                  for (final c in r.currencies) _CurrencyReportView(report: c),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _CurrencyReportView extends StatelessWidget {
  const _CurrencyReportView({required this.report});
  final CurrencyReport report;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    Money m(int minor) => Money(minor, report.currency);
    final t = report.totals;
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Raport lunar · ${report.currency.code}',
            style: text.titleMedium,
          ),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                ListTile(
                  title: const Text('Venituri'),
                  trailing: AmountText(m(t.incomeMinor), signed: true),
                ),
                const Divider(),
                ListTile(
                  title: const Text('Cheltuieli'),
                  trailing: AmountText(m(-t.expenseMinor), signed: true),
                ),
                const Divider(),
                ListTile(
                  title: Text('Sold net', style: text.titleSmall),
                  trailing: AmountText(m(t.netMinor), signed: true, bold: true),
                ),
              ],
            ),
          ),
          if (report.byCategory.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('Cheltuieli pe categorii', style: text.titleSmall),
            const SizedBox(height: 8),
            Card(
              child: Column(
                children: [
                  for (final (i, c) in report.byCategory.indexed) ...[
                    ListTile(
                      title: Text(c.name),
                      subtitle: Text('${c.count} tranzacții · ${c.percent}%'),
                      trailing: AmountText(m(c.amountMinor)),
                    ),
                    if (i != report.byCategory.length - 1) const Divider(),
                  ],
                ],
              ),
            ),
          ],
          if (report.topMerchants.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('Comercianți', style: text.titleSmall),
            const SizedBox(height: 8),
            Card(
              child: Column(
                children: [
                  for (final (i, mer) in report.topMerchants.indexed) ...[
                    ListTile(
                      title: Text(mer.merchant),
                      subtitle: Text(
                        '${mer.count} tranzacții',
                        style: TextStyle(color: context.finet.muted),
                      ),
                      trailing: AmountText(m(mer.amountMinor)),
                    ),
                    if (i != report.topMerchants.length - 1) const Divider(),
                  ],
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
